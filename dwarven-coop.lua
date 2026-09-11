-- dwarven-coop.lua
-- Dwarven Cooperative addon - democratic decision-making via General Assembly
-- Place in: <DF>/hack/scripts/
--
-- Usage:
--   dwarven-coop assembly   - Export current fortress state as JSON (for the companion app)
--   dwarven-coop briefing   - Show current fortress status
--   dwarven-coop status     - Quick status check
--   dwarven-coop members    - Show voting members by faction
--
-- The dwarves have organized themselves as a cooperative.
-- Each quarter the General Assembly convenes. All adult dwarves have 1 vote.

local argparse = require('argparse')
local utils = require('utils')
local json = require('json')

-- ============================================================
-- Utility Functions
-- ============================================================

local function safe_get(fn, default)
    local ok, result = pcall(fn)
    return ok and result or default
end

local function plural(n, word, plural_word)
    return n == 1 and (n .. " " .. word) or (n .. " " .. (plural_word or word .. "s"))
end

local function pct(n, total)
    if total == 0 then return "0%" end
    return math.floor((n / total) * 100) .. "%"
end

local function status_indicator(status)
    local indicators = {
        critical = "!!",
        low = "!",
        adequate = "OK",
        abundant = "++"
    }
    return indicators[status] or "?"
end

-- Check if an item is physically at the fortress (not offsite/world history)
-- Items can be onsite if:
-- 1. They have a valid position (pos.x ~= -30000)
-- 2. They are in a container that has a valid position
-- 3. They are held by a fortress citizen
local function is_item_onsite(item)
    -- Direct position check
    if item.pos.x ~= -30000 then
        return true
    end
    -- Check if in a container that's onsite
    local container = dfhack.items.getContainer(item)
    if container and container.pos.x ~= -30000 then
        return true
    end
    -- Check if held by a citizen
    local holder = dfhack.items.getHolderUnit(item)
    if holder and dfhack.units.isCitizen(holder) then
        return true
    end
    return false
end

-- ============================================================
-- DFHack API Compatibility Helpers
-- ============================================================

local function translate_name(name_obj, in_english)
    if dfhack.translation and dfhack.translation.translateName then
        return dfhack.translation.translateName(name_obj, in_english)
    end
    if dfhack.TranslateName then
        return dfhack.TranslateName(name_obj, in_english)
    end
    return tostring(name_obj)
end

local function is_military(unit)
    if not unit.military then
        return false
    end
    local squad_id = unit.military.squad_id
    if squad_id and squad_id ~= -1 then
        local squad = df.squad.find(squad_id)
        return squad ~= nil
    end
    return false
end

local function get_fortress_info()
    local site = df.global.world.world_data.active_site[0]
    if not site then
        return { name = "Unknown", name_english = "Unknown Fortress", founded_year = 0 }
    end
    return {
        name = translate_name(site.name, false),
        name_english = translate_name(site.name, true),
        founded_year = safe_get(function() return site.created_year end, 0)
    }
end

local function get_buildings_summary()
    local counts = {
        workshops = 0,
        workshop_types = {},
        furnaces = 0,
        furnace_types = {},
        beds = 0,
        tables = 0,
        chairs = 0
    }

    for _, bld in ipairs(df.global.world.buildings.all) do
        local btype = bld:getType()
        if btype == df.building_type.Workshop then
            counts.workshops = counts.workshops + 1
            local subtype = safe_get(function() return df.workshop_type[bld:getSubtype()] end, "unknown")
            counts.workshop_types[subtype] = (counts.workshop_types[subtype] or 0) + 1
        elseif btype == df.building_type.Furnace then
            counts.furnaces = counts.furnaces + 1
            local subtype = safe_get(function() return df.furnace_type[bld:getSubtype()] end, "unknown")
            counts.furnace_types[subtype] = (counts.furnace_types[subtype] or 0) + 1
        elseif btype == df.building_type.Bed then
            counts.beds = counts.beds + 1
        elseif btype == df.building_type.Table then
            counts.tables = counts.tables + 1
        elseif btype == df.building_type.Chair then
            counts.chairs = counts.chairs + 1
        end
    end

    return counts
end

-- ============================================================
-- Factions within the Cooperative
-- ============================================================

-- Dwarves are assigned to factions based on their profession
local FACTIONS = {
    {
        id = "producers",
        name = "Producers Collective",
        professions = {
            "CRAFTSMAN", "WOODWORKER", "STONEWORKER", "RANGER",
            "METALSMITH", "JEWELER", "CRAFTSDWARF", "MASON",
            "CARPENTER", "LEATHERWORKER", "WEAVER", "CLOTHIER",
            "GLASSMAKER", "POTTER", "STRAND_EXTRACTOR", "SIEGE_ENGINEER",
            "WEAPONSMITH", "ARMORER", "BLACKSMITH", "BOWYER"
        }
    },
    {
        id = "food",
        name = "Food Council",
        professions = {
            "FARMER", "COOK", "BREWER", "BUTCHER", "TANNER",
            "CHEESE_MAKER", "MILKER", "HERBALIST", "THRESHER",
            "MILLER", "FISH_CLEANER", "FISHERMAN", "PRESSER"
        }
    },
    {
        id = "delvers",
        name = "Delvers Guild",
        professions = {
            "MINER", "ENGRAVER", "MECHANIC", "ENGINEER",
            "PUMP_OPERATOR", "GELDER"
        }
    },
    {
        id = "defenders",
        name = "Defenders Union",
        professions = {
            "WRESTLER", "AXE", "SWORD", "MACE", "HAMMER",
            "SPEAR", "CROSSBOW", "SHIELD", "ARMOR", "WEAPONUSER",
            "RECRUIT", "HUNTER", "MARKSDWARF", "WRESTLER"
        }
    },
    {
        id = "caregivers",
        name = "Care Collective",
        professions = {
            "DOCTOR", "DIAGNOSER", "BONE_SETTER", "SURGEON",
            "SUTURER", "CHIEF_MEDICAL_DWARF", "ANIMAL_CARETAKER"
        }
    },
    {
        id = "services",
        name = "Services Sector",
        professions = {
            "TRADER", "BROKER", "CLERK", "ADMINISTRATOR",
            "MANAGER", "BOOKKEEPER", "HAULER", "PEASANT"
        }
    }
}

-- ============================================================
-- Game State Extraction (Cooperative-specific)
-- ============================================================

local function get_date()
    local year = df.global.cur_year
    local tick = df.global.cur_year_tick
    local day = math.floor(tick / 1200) + 1
    local month = math.floor((day - 1) / 28) + 1
    local day_of_month = ((day - 1) % 28) + 1
    
    local seasons = {'Spring', 'Summer', 'Autumn', 'Winter'}
    local season = seasons[math.floor((month - 1) / 3) + 1]
    
    local month_names = {
        "Granite", "Slate", "Felsite",
        "Hematite", "Malachite", "Galena", 
        "Limestone", "Sandstone", "Timber",
        "Moonstone", "Opal", "Obsidian"
    }
    
    return {
        year = year,
        month = month,
        month_name = month_names[month] or "Unknown",
        day = day_of_month,
        season = season,
        tick = tick
    }
end

-- Convert any year/tick to a date object
local function tick_to_date(year, tick)
    local month_names = {
        "Granite", "Slate", "Felsite",
        "Hematite", "Malachite", "Galena",
        "Limestone", "Sandstone", "Timber",
        "Moonstone", "Opal", "Obsidian"
    }
    local seasons = {'Spring', 'Summer', 'Autumn', 'Winter'}

    local day = math.floor(tick / 1200) + 1
    local month = math.floor((day - 1) / 28) + 1
    month = math.max(1, math.min(12, month))  -- Clamp to valid range
    local day_of_month = ((day - 1) % 28) + 1
    local season = seasons[math.floor((month - 1) / 3) + 1]

    return {
        year = year,
        month = month,
        month_name = month_names[month] or "Unknown",
        day = day_of_month,
        season = season
    }
end

-- Format a date object as a readable string
local function format_date_string(date, year_only)
    if year_only then
        return string.format("Year %d", date.year)
    end
    return string.format("%d %s, Year %d", date.day, date.month_name, date.year)
end

-- Determine faction for a dwarf based on profession
local function get_faction_for_profession(profession_name)
    for _, faction in ipairs(FACTIONS) do
        for _, prof in ipairs(faction.professions) do
            if profession_name:upper():find(prof) then
                return faction.id
            end
        end
    end
    return "services"  -- Default faction
end

local function analyze_population()
    local summary = {
        total = 0,
        adults = 0,
        children = 0,
        eligible_voters = 0,  -- Only adults may vote
        military = 0,
        injured = 0,
        stress = {
            joyous = 0, happy = 0, content = 0, fine = 0,
            unhappy = 0, stressed = 0, miserable = 0
        },
        factions = {}
    }
    
    -- Initialize faction counts
    for _, faction in ipairs(FACTIONS) do
        summary.factions[faction.id] = {
            name = faction.name,
            members = 0,
            votes = 0,  -- = members (1 dwarf = 1 vote)
            dwarves = {}  -- Store actual dwarf units for spokesperson selection
        }
    end
    
    local stress_categories = {
        [0] = "miserable",  -- Negative (lowest)
        [1] = "stressed",   -- Negative
        [2] = "unhappy",    -- Neutral (lower)
        [3] = "fine",       -- Neutral (middle)
        [4] = "content",    -- Neutral (upper)
        [5] = "happy",      -- Positive
        [6] = "joyous"      -- Positive (highest)
    }

    for _, unit in ipairs(df.global.world.units.active) do
        if dfhack.units.isCitizen(unit) and dfhack.units.isAlive(unit) then
            summary.total = summary.total + 1

            local is_child = dfhack.units.isChild(unit) or dfhack.units.isBaby(unit)

            if is_child then
                summary.children = summary.children + 1
            else
                summary.adults = summary.adults + 1
                summary.eligible_voters = summary.eligible_voters + 1

                -- Determine faction
                local profession = df.profession[unit.profession] or "PEASANT"
                local faction_id = get_faction_for_profession(profession)

                if summary.factions[faction_id] then
                    summary.factions[faction_id].members = summary.factions[faction_id].members + 1
                    summary.factions[faction_id].votes = summary.factions[faction_id].members
                    table.insert(summary.factions[faction_id].dwarves, unit)
                end
            end

            if is_military(unit) then
                summary.military = summary.military + 1
            end

            if unit.health and unit.health.flags.needs_healthcare then
                summary.injured = summary.injured + 1
            end

            local stress_cat = dfhack.units.getStressCategory(unit)
            local cat_name = stress_categories[stress_cat]
            if cat_name and summary.stress[cat_name] then
                summary.stress[cat_name] = summary.stress[cat_name] + 1
            end
        end
    end

    return summary
end

local function get_personality_traits(unit)
    local traits = {}
    local trait_descriptions = {}

    if unit.status.current_soul then
        local soul = unit.status.current_soul

        -- Get personality facets (the actual DF personality system)
        for _, facet in ipairs(soul.personality.traits) do
            local value = facet  -- Values range 0-100, 50 is average
            local trait_name = df.personality_facet_type[_]

            if trait_name then
                -- Only report extreme traits (< 30 or > 70)
                if value < 30 then
                    table.insert(trait_descriptions, "low " .. trait_name:lower():gsub("_", " "))
                elseif value > 70 then
                    table.insert(trait_descriptions, "high " .. trait_name:lower():gsub("_", " "))
                end
            end
        end

        -- Limit to top 3 most extreme traits
        if #trait_descriptions > 3 then
            local temp = {}
            for i = 1, 3 do
                table.insert(temp, trait_descriptions[i])
            end
            trait_descriptions = temp
        end
    end

    return trait_descriptions
end

local function select_faction_spokespersons(factions)
    local spokespersons = {}

    for faction_id, faction_data in pairs(factions) do
        if #faction_data.dwarves > 0 then
            -- Select the first adult dwarf as spokesperson (could be randomized)
            local spokesperson = faction_data.dwarves[1]
            local name = translate_name(spokesperson.name, false)
            local personality = get_personality_traits(spokesperson)

            spokespersons[faction_id] = {
                name = name,
                personality = personality,
                profession = df.profession[spokesperson.profession] or "PEASANT"
            }
        end
    end

    return spokespersons
end

local function get_resources(population)
    local food_count = 0
    local drink_count = 0
    local food_types = {
        prepared_meals = 0,
        fish = 0,
        meat = 0,
        plants = 0,
        cheese = 0,
        eggs = 0,
        other = 0
    }
    local drink_types = {}

    -- Calculate wealth by summing item values (df.global.plotinfo.wealth.total is often 0)
    local total_wealth = 0
    local created_wealth = 0

    for _, item in ipairs(df.global.world.items.all) do
        -- Filter out items that aren't ours or aren't available
        if not item.flags.trader and
           not item.flags.hostile and
           not item.flags.removed and
           not item.flags.forbid and
           not item.flags.dump and
           is_item_onsite(item) then

            -- Calculate item value for wealth tracking
            local item_value = safe_get(function() return dfhack.items.getValue(item) end, 0)
            if item_value > 0 then
                total_wealth = total_wealth + item_value
                -- Check if fortress-made (has a maker)
                local maker_race = safe_get(function() return item.maker_race end, -1)
                if maker_race ~= -1 then
                    created_wealth = created_wealth + item_value
                end
            end

            if df.item_foodst:is_instance(item) then
                -- Prepared meals can be stacked
                local size = item.stack_size
                local count = (size > 0) and size or 1
                food_count = food_count + count
                food_types.prepared_meals = food_types.prepared_meals + count
            elseif df.item_fishst:is_instance(item) or df.item_fish_rawst:is_instance(item) then
                local size = item.stack_size
                local count = (size > 0) and size or 1
                food_count = food_count + count
                food_types.fish = food_types.fish + count
            elseif df.item_meatst:is_instance(item) then
                local size = item.stack_size
                local count = (size > 0) and size or 1
                food_count = food_count + count
                food_types.meat = food_types.meat + count
            elseif df.item_plantst:is_instance(item) then
                local size = item.stack_size
                local count = (size > 0) and size or 1
                food_count = food_count + count
                food_types.plants = food_types.plants + count
            elseif df.item_cheesest:is_instance(item) then
                local size = item.stack_size
                local count = (size > 0) and size or 1
                food_count = food_count + count
                food_types.cheese = food_types.cheese + count
            elseif df.item_eggst:is_instance(item) then
                local size = item.stack_size
                local count = (size > 0) and size or 1
                food_count = food_count + count
                food_types.eggs = food_types.eggs + count
            elseif df.item_globst:is_instance(item) then
                local size = item.stack_size
                local count = (size > 0) and size or 1
                food_count = food_count + count
                food_types.other = food_types.other + count
            elseif df.item_drinkst:is_instance(item) then
                local size = item.stack_size
                local count = (size > 0) and size or 1
                drink_count = drink_count + count

                -- Track drink types
                local drink_type = "unknown"
                if item.mat_type >= 0 then
                    local mat = dfhack.matinfo.decode(item.mat_type, item.mat_index)
                    if mat then
                        drink_type = mat:toString()
                    end
                end
                drink_types[drink_type] = (drink_types[drink_type] or 0) + count
            end
        end
    end

    -- Calculate days of supply based on population
    -- Dwarves eat ~2 times per season (84 days), drink ~5 times per season
    local function status_for_supply(count, consumption_per_season)
        local pop = population or 1
        if pop == 0 then pop = 1 end

        -- Calculate days of supply: (count / pop) / (consumption_per_season / 84)
        local days_of_supply = (count * 84) / (pop * consumption_per_season)

        if days_of_supply > 168 then return "abundant", days_of_supply      -- > 2 seasons
        elseif days_of_supply > 84 then return "adequate", days_of_supply   -- > 1 season
        elseif days_of_supply > 42 then return "low", days_of_supply        -- > 0.5 season
        else return "critical", days_of_supply end                           -- <= 0.5 season
    end

    local food_status, food_days = status_for_supply(food_count, 2)
    local drink_status, drink_days = status_for_supply(drink_count, 5)

    return {
        food = {
            count = food_count,
            status = food_status,
            days_of_supply = math.floor(food_days),
            types = food_types
        },
        drink = {
            count = drink_count,
            status = drink_status,
            days_of_supply = math.floor(drink_days),
            types = drink_types
        },
        wealth = {
            total = total_wealth,
            created = created_wealth,
            imported = total_wealth - created_wealth
        }
    }
end

local function get_trade_goods()
    local trade_goods = {
        artifacts = 0,
        masterworks = 0,
        gems_cut = 0,
        gems_rough = 0,
        crafts = 0,
        total_value = 0
    }

    for _, item in ipairs(df.global.world.items.all) do
        -- Skip items that aren't ours or are forbidden
        if not item.flags.trader and
           not item.flags.hostile and
           not item.flags.removed and
           not item.flags.forbid and
           not item.flags.dump and
           not item.flags.in_building and
           is_item_onsite(item) then

            local quality = safe_get(function() return item.quality end, 0)
            local is_tradeable = false

            -- Check if item was made by a fortress dwarf (exclude embark items)
            local maker_race = safe_get(function() return item.maker_race end, -1)
            local is_fortress_made = maker_race ~= -1  -- Items with a maker are fortress-made

            -- Check for TRUE artifacts (must have a name - artifacts from strange moods are always named)
            local is_artifact = false
            local has_name = safe_get(function()
                if not item.name then return false end
                -- Check if any part of the name is filled in
                return item.name.has_name or
                       (item.name.first_name and #item.name.first_name > 0) or
                       (item.name.nickname and #item.name.nickname > 0)
            end, false)

            -- Only count artifacts made in the fortress
            if has_name and is_fortress_made then
                is_artifact = true
                trade_goods.artifacts = trade_goods.artifacts + 1
                is_tradeable = true
            end

            -- Only count masterworks made in the fortress that are actual trade goods
            -- (exclude artifacts, embark items, construction materials, weapons, armor, tools)
            if quality >= 5 and not is_artifact and is_fortress_made then
                -- Explicitly exclude certain item types that are never trade goods
                local item_type_num = safe_get(function() return item:getType() end, -1)
                local is_excluded_type = (item_type_num == 13)  -- DOOR/SLAB (memorial slabs incorrectly match as instruments)

                -- Check if this is actually a trade good type
                local is_trade_good_type = false

                -- Check each type individually to see which one matches
                if not is_excluded_type and df.item_craftst and df.item_craftst:is_instance(item) then
                    is_trade_good_type = true
                elseif not is_excluded_type and df.item_toyst and df.item_toyst:is_instance(item) then
                    is_trade_good_type = true
                elseif not is_excluded_type and df.item_instrumentst and df.item_instrumentst:is_instance(item) then
                    is_trade_good_type = true
                elseif not is_excluded_type and df.item_gobletst and df.item_gobletst:is_instance(item) then
                    is_trade_good_type = true
                elseif not is_excluded_type and df.item_totemst and df.item_totemst:is_instance(item) then
                    is_trade_good_type = true
                elseif not is_excluded_type and df.item_statuest and df.item_statuest:is_instance(item) then
                    is_trade_good_type = true
                elseif not is_excluded_type and df.item_amulettst and df.item_amulettst:is_instance(item) then
                    is_trade_good_type = true
                elseif not is_excluded_type and df.item_ringst and df.item_ringst:is_instance(item) then
                    is_trade_good_type = true
                elseif not is_excluded_type and df.item_earringst and df.item_earringst:is_instance(item) then
                    is_trade_good_type = true
                elseif not is_excluded_type and df.item_braceletst and df.item_braceletst:is_instance(item) then
                    is_trade_good_type = true
                elseif not is_excluded_type and df.item_scepterst and df.item_scepterst:is_instance(item) then
                    is_trade_good_type = true
                elseif not is_excluded_type and df.item_crownst and df.item_crownst:is_instance(item) then
                    is_trade_good_type = true
                end

                if is_trade_good_type then
                    trade_goods.masterworks = trade_goods.masterworks + 1
                    is_tradeable = true
                end
            end

            -- Count gems (only cut gems made in fortress)
            if df.item_gemst:is_instance(item) and is_fortress_made then
                local is_cut = safe_get(function() return item.flags.cut end, false)
                if is_cut then
                    trade_goods.gems_cut = trade_goods.gems_cut + 1
                    is_tradeable = true
                end
                -- Don't count rough gems as trade goods
            end

            -- Count high-value crafts made in fortress (rock/wood/metal crafts for trading)
            -- Exclude type 13 (DOOR/SLAB) which incorrectly matches as instrument
            local item_type_num_craft = safe_get(function() return item:getType() end, -1)
            local is_craft = safe_get(function()
                return item_type_num_craft ~= 13 and (
                    (df.item_craftst and df.item_craftst:is_instance(item)) or
                    (df.item_toyst and df.item_toyst:is_instance(item)) or
                    (df.item_instrumentst and df.item_instrumentst:is_instance(item))
                )
            end, false)

            if is_craft and quality >= 3 and is_fortress_made then  -- Fine quality or better, made in fortress
                trade_goods.crafts = trade_goods.crafts + 1
                is_tradeable = true
            end

            -- Calculate value for tradeable items using DFHack API
            if is_tradeable then
                local item_value = safe_get(function() return dfhack.items.getValue(item) end, 0)
                trade_goods.total_value = trade_goods.total_value + item_value
            end
        end
    end

    return trade_goods
end

local function get_skill_level(unit, skill_id)
    if not unit.status.current_soul or not skill_id then
        return 0, "Dabbling"
    end

    local skill_levels = {
        [0] = "Dabbling", [1] = "Novice", [2] = "Adequate", [3] = "Competent",
        [4] = "Skilled", [5] = "Proficient", [6] = "Talented", [7] = "Adept",
        [8] = "Expert", [9] = "Professional", [10] = "Accomplished", [11] = "Great",
        [12] = "Master", [13] = "High Master", [14] = "Grand Master", [15] = "Legendary"
    }

    for _, skill in ipairs(unit.status.current_soul.skills) do
        if skill.id == skill_id then
            -- Rating is the skill level directly (0=Dabbling, 1=Novice, 2=Adequate, etc.)
            local level = math.min(15, skill.rating)
            return level, skill_levels[level] or "Unknown"
        end
    end

    return 0, "Dabbling"
end

local function get_unit_equipment(unit)
    local equipment = {
        weapon = "none",
        armor = {},
        shield = "none"
    }

    if not unit.inventory then
        return equipment
    end

    for _, inv_item in ipairs(unit.inventory) do
        local item = inv_item.item
        if item then
            local mode = inv_item.mode

            -- Check weapons in wielded (mode 1) or uniform (mode 10) slots
            if mode == 1 or mode == 10 then
                if df.item_weaponst:is_instance(item) then
                    local mat = dfhack.matinfo.decode(item)
                    local mat_name = mat and mat:toString() or "unknown"
                    local weapon_type = item.subtype and item.subtype.name or "weapon"
                    equipment.weapon = mat_name .. " " .. weapon_type
                end
            end

            -- Check armor and shields in worn (mode 2) or uniform (mode 10) slots
            if mode == 2 or mode == 10 then
                if df.item_armorst:is_instance(item) or df.item_helmst:is_instance(item) or
                   df.item_glovesst:is_instance(item) or df.item_pantsst:is_instance(item) or
                   df.item_shoesst:is_instance(item) then
                    local mat = dfhack.matinfo.decode(item)
                    local mat_name = mat and mat:toString() or "unknown"
                    local armor_type = item.subtype and item.subtype.name or "armor"
                    table.insert(equipment.armor, mat_name .. " " .. armor_type)
                elseif df.item_shieldst:is_instance(item) then
                    local mat = dfhack.matinfo.decode(item)
                    local mat_name = mat and mat:toString() or "unknown"
                    equipment.shield = mat_name .. " shield"
                end
            end
        end
    end

    return equipment
end

local function get_military()
    local squads = {}

    -- Get our fortress's entity
    local fort_ent = df.historical_entity.find(df.global.plotinfo.group_id)

    for _, squad in ipairs(df.global.world.squads.all) do
        -- Check if this squad belongs to our fortress by checking if it's in our entity's squads list
        local is_ours = false
        if fort_ent and fort_ent.squads then
            for _, our_squad_id in ipairs(fort_ent.squads) do
                if our_squad_id == squad.id then
                    is_ours = true
                    break
                end
            end
        end

        if is_ours then
            local members = {}

            for _, pos in ipairs(squad.positions) do
                if pos.occupant ~= -1 then
                    -- Find unit - pos.occupant is a historical figure ID, not a unit ID
                    local unit = nil
                    local hist_fig = df.historical_figure.find(pos.occupant)
                    if hist_fig and hist_fig.unit_id and hist_fig.unit_id ~= -1 then
                        -- Find the unit by its ID
                        for _, u in ipairs(df.global.world.units.active) do
                            if u.id == hist_fig.unit_id then
                                unit = u
                                break
                            end
                        end
                    end

                    if unit then
                        local name = translate_name(unit.name, false)
                        local equipment = get_unit_equipment(unit)

                        -- Get combat skills: MELEE_COMBAT (ID 97) and DODGING
                        local fighter_level, fighter_desc = get_skill_level(unit, 97)
                        local dodger_level, dodger_desc = get_skill_level(unit, df.job_skill.DODGING)

                        -- Get weapon skill based on equipped weapon
                        local weapon_skill_desc = "none"
                        if equipment.weapon ~= "none" then
                            -- Try to get weapon-specific skill
                            -- This is simplified - in reality would check weapon type
                            local axe_level, axe_desc = get_skill_level(unit, df.job_skill.AXE)
                            local sword_level, sword_desc = get_skill_level(unit, df.job_skill.SWORD)
                            local hammer_level, hammer_desc = get_skill_level(unit, df.job_skill.HAMMER)
                            local spear_level, spear_desc = get_skill_level(unit, df.job_skill.SPEAR)
                            local mace_level, mace_desc = get_skill_level(unit, df.job_skill.MACE)
                            local crossbow_level, crossbow_desc = get_skill_level(unit, df.job_skill.CROSSBOW)

                            -- Use highest weapon skill
                            local max_level = math.max(axe_level, sword_level, hammer_level, spear_level, mace_level, crossbow_level)
                            if max_level == axe_level and axe_level > 0 then weapon_skill_desc = "Axe: " .. axe_desc
                            elseif max_level == sword_level and sword_level > 0 then weapon_skill_desc = "Sword: " .. sword_desc
                            elseif max_level == hammer_level and hammer_level > 0 then weapon_skill_desc = "Hammer: " .. hammer_desc
                            elseif max_level == spear_level and spear_level > 0 then weapon_skill_desc = "Spear: " .. spear_desc
                            elseif max_level == mace_level and mace_level > 0 then weapon_skill_desc = "Mace: " .. mace_desc
                            elseif max_level == crossbow_level and crossbow_level > 0 then weapon_skill_desc = "Crossbow: " .. crossbow_desc
                            end
                        end

                        table.insert(members, {
                            name = name,
                            equipment = equipment,
                            skills = {
                                fighter = fighter_desc,
                                dodger = dodger_desc,
                                weapon = weapon_skill_desc
                            }
                        })
                    end
                end
            end

            if #members > 0 then
                table.insert(squads, {
                    name = translate_name(squad.name, false),
                    members = members
                })
            end
        end
    end

    return { squad_count = #squads, squads = squads }
end

local function get_defensive_structures()
    local defenses = {
        fortifications = 0,
        walls = 0,
        traps = 0,
        bridges = 0,
        spike_traps = 0,
        weapon_traps = 0,
        cage_traps = 0,
        stone_traps = 0
    }

    for _, bld in ipairs(df.global.world.buildings.all) do
        local btype = bld:getType()

        -- Fortifications
        if btype == df.building_type.Fortification then
            defenses.fortifications = defenses.fortifications + 1

        -- Walls (constructed walls, not natural)
        elseif btype == df.building_type.Construction then
            local subtype = bld:getSubtype()
            if subtype == df.construction_type.Wall then
                defenses.walls = defenses.walls + 1
            elseif subtype == df.construction_type.Fortification then
                defenses.fortifications = defenses.fortifications + 1
            end

        -- Bridges (drawbridges for defense)
        elseif btype == df.building_type.Bridge then
            defenses.bridges = defenses.bridges + 1

        -- Traps
        elseif btype == df.building_type.Trap then
            defenses.traps = defenses.traps + 1

            -- Get trap subtype for more detail
            local trap_type = safe_get(function() return bld:getSubtype() end, -1)
            if trap_type == df.trap_type.StoneFallTrap then
                defenses.stone_traps = defenses.stone_traps + 1
            elseif trap_type == df.trap_type.WeaponTrap then
                defenses.weapon_traps = defenses.weapon_traps + 1
            elseif trap_type == df.trap_type.Lever then
                -- Skip levers, not really defensive
                defenses.traps = defenses.traps - 1
            elseif trap_type == df.trap_type.PressurePlate then
                -- Skip pressure plates themselves
                defenses.traps = defenses.traps - 1
            elseif trap_type == df.trap_type.CageTrap then
                defenses.cage_traps = defenses.cage_traps + 1
            elseif trap_type == df.trap_type.TrackStop then
                -- Skip track stops
                defenses.traps = defenses.traps - 1
            end
        end
    end

    return defenses
end

-- Get historical figure name by ID
local function get_hf_name(hf_id)
    local hf = df.historical_figure.find(hf_id)
    if hf and hf.name then
        return translate_name(hf.name, false)
    end
    return nil
end

-- Check if a historical figure is a fortress citizen
local function is_fortress_hf(hf_id)
    local hf = df.historical_figure.find(hf_id)
    if not hf then return false end

    -- Check if this HF has a unit in our fortress
    if hf.unit_id and hf.unit_id ~= -1 then
        for _, unit in ipairs(df.global.world.units.active) do
            if unit.id == hf.unit_id and dfhack.units.isCitizen(unit) then
                return true
            end
        end
    end
    return false
end

-- Get fortress history combining multiple data sources
local function get_fortress_history()
    local events = {}
    local current_year = df.global.cur_year
    local current_tick = df.global.cur_year_tick
    local lookback_years = 2  -- Look back 2 years for context

    local site_id = safe_get(function()
        return df.global.world.world_data.active_site[0].id
    end, -1)

    -- Track units with completed moods (to filter out stale STRANGE_MOOD announcements)
    local units_with_artifacts = {}
    for _, unit in ipairs(df.global.world.units.active) do
        if dfhack.units.isCitizen(unit) then
            local has_artifact = safe_get(function()
                return unit.status and unit.status.artifact_name and unit.status.artifact_name.has_name
            end, false)
            if has_artifact then
                local name = translate_name(unit.name, false)
                units_with_artifacts[name] = true
            end
        end
    end

    -- Track artifacts we've added to avoid duplicates
    local seen_artifact_ids = {}

    -- 1. Scan artifacts directly for written works and other items without history events
    for _, artifact in ipairs(df.global.world.artifacts.all) do
        local item = artifact.item
        if item then
            local maker_id = safe_get(function() return item.maker end, -1)
            local is_ours = maker_id ~= -1 and is_fortress_hf(maker_id)

            if is_ours then
                local artifact_name = safe_get(function()
                    return translate_name(artifact.name, true)
                end, nil)

                -- Only include named artifacts (skip unnamed items)
                if artifact_name and artifact_name ~= "" then
                    local maker_name = get_hf_name(maker_id) or "Someone"
                    local item_desc = safe_get(function()
                        return dfhack.items.getDescription(item, 0, true)
                    end, "item")

                    -- Get item age to estimate creation year
                    local item_age = safe_get(function() return item.age end, 0)
                    local creation_year = current_year
                    if item_age > 0 then
                        -- item.age is in ticks, a year is ~403200 ticks
                        creation_year = current_year - math.floor(item_age / 403200)
                    end

                    if creation_year >= current_year - lookback_years then
                        local artifact_id = safe_get(function() return artifact.id end, -1)
                        seen_artifact_ids[artifact_id] = true

                        table.insert(events, {
                            date = tick_to_date(creation_year, 0),
                            sort_key = creation_year * 1000000,
                            type = "ARTIFACT",
                            importance = "high",
                            year_only = true,  -- We only know the year from artifact scanning
                            text = string.format('%s created "%s" (%s)', maker_name, artifact_name, item_desc)
                        })
                    end
                end
            end
        end
    end

    -- 2. Parse history events for significant fortress events
    local history_events = df.global.world.history.events
    local start_idx = math.max(0, #history_events - 500)  -- Limit search for performance

    for i = #history_events - 1, start_idx, -1 do
        local evt = history_events[i]
        local evt_year = safe_get(function() return evt.year end, 0)

        if evt_year < current_year - lookback_years then
            break  -- Events are sorted by time, so we can stop
        end

        local evt_type = safe_get(function() return evt:getType() end, -1)
        local evt_seconds = safe_get(function() return evt.seconds72 end, 0)
        local evt_tick = evt_seconds * 72  -- Convert to ticks (approximate)

        -- HIST_FIGURE_DIED - Deaths
        if evt_type == df.history_event_type.HIST_FIGURE_DIED then
            local hf_id = safe_get(function() return evt.victim_hf end, -1)
            if hf_id ~= -1 then
                local name = get_hf_name(hf_id)
                local death_cause = safe_get(function()
                    return df.death_type[evt.death_cause]
                end, "unknown")

                -- Only include if it seems fortress-related
                local evt_site = safe_get(function() return evt.site end, -1)
                if evt_site == site_id or is_fortress_hf(hf_id) then
                    local cause_text = death_cause:lower():gsub("_", " ")
                    table.insert(events, {
                        date = tick_to_date(evt_year, evt_tick),
                        sort_key = evt_year * 1000000 + evt_seconds,
                        type = "DEATH",
                        importance = "high",
                        text = string.format("%s died (%s)", name or "Someone", cause_text)
                    })
                end
            end
        end

        -- CHANGE_HF_STATE - Migration/visitors becoming residents
        if evt_type == df.history_event_type.CHANGE_HF_STATE then
            local hf_id = safe_get(function() return evt.hfid end, -1)
            local new_state = safe_get(function() return evt.state end, -1)
            local evt_site = safe_get(function() return evt.site end, -1)

            if evt_site == site_id and hf_id ~= -1 then
                local name = get_hf_name(hf_id)
                -- state 1 = settled, which indicates migration
                if new_state == 1 and name then
                    table.insert(events, {
                        date = tick_to_date(evt_year, evt_tick),
                        sort_key = evt_year * 1000000 + evt_seconds,
                        type = "MIGRANT",
                        importance = "medium",
                        text = string.format("%s joined the fortress", name)
                    })
                end
            end
        end

        -- ARTIFACT_CREATED - Strange mood completion (skip if already found in artifact scan)
        if evt_type == df.history_event_type.ARTIFACT_CREATED then
            local artifact_id = safe_get(function() return evt.artifact_id end, -1)

            -- Skip if we already added this artifact from the direct scan
            if artifact_id ~= -1 and not seen_artifact_ids[artifact_id] then
                -- Try multiple field names for historical figure ID
                local hf_id = safe_get(function() return evt.hfid end, nil)
                           or safe_get(function() return evt.hist_figure_id end, nil)
                           or safe_get(function() return evt.creator_hfid end, nil)
                           or -1
                local evt_site = safe_get(function() return evt.site end, -1)
                local artifact = df.artifact_record.find(artifact_id)
                if artifact and artifact.item then
                    -- Get maker from the item itself (more reliable)
                    local item_maker_id = safe_get(function() return artifact.item.maker end, -1)
                    local is_ours = (evt_site == site_id)
                                 or (item_maker_id ~= -1 and is_fortress_hf(item_maker_id))
                                 or (hf_id ~= -1 and is_fortress_hf(hf_id))

                    if is_ours then
                        -- Get maker name from item.maker (historical figure ID)
                        local maker_name = nil
                        if item_maker_id ~= -1 then
                            maker_name = get_hf_name(item_maker_id)
                        end
                        if not maker_name and hf_id ~= -1 then
                            maker_name = get_hf_name(hf_id)
                        end
                        maker_name = maker_name or "Someone"

                        local artifact_name = safe_get(function()
                            return translate_name(artifact.name, true)
                        end, "an artifact")

                        local item_desc = safe_get(function()
                            return dfhack.items.getDescription(artifact.item, 0, true)
                        end, "item")

                        -- Use seconds72 for date if available
                        -- seconds72 is time in 72-second intervals since year start
                        local has_precise_date = evt_seconds > 0
                        local actual_tick = 0
                        if has_precise_date then
                            -- A year has about 403200 ticks, seconds72 max is ~50000
                            actual_tick = math.floor((evt_seconds / 50000) * 403200)
                        end

                        table.insert(events, {
                            date = tick_to_date(evt_year, actual_tick),
                            sort_key = evt_year * 1000000 + evt_seconds,
                            type = "ARTIFACT",
                            importance = "high",
                            year_only = not has_precise_date,
                            text = string.format('%s created "%s" (%s)', maker_name, artifact_name, item_desc)
                        })
                    end
                end
            end
        end
    end

    -- 3. Get recent announcements (but filter out completed moods)
    local important_types = {
        CARAVAN = true, DIPLOMAT = true, SIEGE = true, AMBUSH = true,
        BIRTH = true, DEATH = true, MASTERPIECE = true,
        STRANGE_MOOD = true, MEGABEAST = true, MANDATE = true, MIGRANT = true
    }

    local lookback_ticks = 1200 * 28 * 6  -- 6 months of announcements

    for i = #df.global.world.status.announcements - 1, 0, -1 do
        local ann = df.global.world.status.announcements[i]
        local ann_year = safe_get(function() return ann.year end, 0)
        local ann_tick = safe_get(function() return ann.time end, 0)

        if ann_year < current_year - 1 then
            break
        end

        -- Calculate if within lookback period
        local is_recent = false
        if ann_year == current_year then
            is_recent = (current_tick - ann_tick) < lookback_ticks
        elseif ann_year == current_year - 1 then
            local ticks_in_year = 1200 * 28 * 12
            local age = (ticks_in_year - ann_tick) + current_tick
            is_recent = age < lookback_ticks
        end

        if is_recent then
            local type_name = safe_get(function()
                return df.announcement_type[ann.type]
            end, "OTHER")

            if important_types[type_name] then
                local text = safe_get(function() return ann.text end, "")

                -- Filter out STRANGE_MOOD if the dwarf already made an artifact
                local skip = false
                if type_name == "STRANGE_MOOD" then
                    for unit_name, _ in pairs(units_with_artifacts) do
                        if text:find(unit_name) then
                            skip = true
                            break
                        end
                    end
                end

                if not skip then
                    table.insert(events, {
                        date = tick_to_date(ann_year, ann_tick),
                        sort_key = ann_year * 1000000 + ann_tick,
                        type = type_name,
                        importance = (type_name == "SIEGE" or type_name == "AMBUSH" or type_name == "MEGABEAST") and "high" or "medium",
                        text = text
                    })
                end
            end
        end

        if #events >= 30 then break end
    end

    -- Sort events by date (most recent first)
    table.sort(events, function(a, b) return a.sort_key > b.sort_key end)

    -- Limit to 20 most relevant events
    local result = {}
    for i = 1, math.min(20, #events) do
        result[i] = events[i]
    end

    return result
end

-- Legacy function for compatibility
local function get_recent_events()
    local history = get_fortress_history()
    local events = {}
    for _, evt in ipairs(history) do
        table.insert(events, { text = evt.text, type = evt.type })
    end
    return events
end

local function get_zones()
    local zones = {
        bedrooms = 0,
        dining_halls = 0,
        meeting_areas = 0,
        barracks = 0,
        offices = {},  -- List of {owner_name, positions}
        pens = 0,
        tombs = 0,
        other = 0
    }

    for _, bld in ipairs(df.global.world.buildings.all) do
        if bld:getType() == df.building_type.Civzone then
            local zone_type = bld:getSubtype()
            if zone_type == df.civzone_type.Bedroom then
                zones.bedrooms = zones.bedrooms + 1
            elseif zone_type == df.civzone_type.DiningHall then
                zones.dining_halls = zones.dining_halls + 1
            elseif zone_type == df.civzone_type.MeetingHall then
                zones.meeting_areas = zones.meeting_areas + 1
            elseif zone_type == df.civzone_type.Barracks then
                zones.barracks = zones.barracks + 1
            elseif zone_type == df.civzone_type.Office then
                local owner = safe_get(function() return dfhack.buildings.getOwner(bld) end, nil)
                if owner then
                    local positions = safe_get(function() return dfhack.units.getNoblePositions(owner) end, {})
                    local position_names = {}
                    if positions then
                        for _, p in ipairs(positions) do
                            local pos_name = safe_get(function() return p.position.name[0] end, nil)
                            if pos_name then
                                table.insert(position_names, pos_name)
                            end
                        end
                    end
                    table.insert(zones.offices, {
                        owner_name = translate_name(owner.name, false),
                        positions = position_names
                    })
                else
                    table.insert(zones.offices, { owner_name = "unassigned", positions = {} })
                end
            elseif zone_type == df.civzone_type.Pen then
                zones.pens = zones.pens + 1
            elseif zone_type == df.civzone_type.Tomb then
                zones.tombs = zones.tombs + 1
            else
                zones.other = zones.other + 1
            end
        end
    end

    return zones
end

local function get_locations()
    local locations = {
        hospitals = {},
        taverns = {},
        temples = {},
        libraries = {},
        guildhalls = {}
    }

    local site = safe_get(function() return df.global.world.world_data.active_site[0] end, nil)
    if not site or not site.buildings then
        return locations
    end

    for _, bld in ipairs(site.buildings) do
        if df.abstract_building_hospitalst and df.abstract_building_hospitalst:is_instance(bld) then
            local hospital = {
                name = safe_get(function() return translate_name(bld.name, false) end, "Hospital"),
                name_english = safe_get(function() return translate_name(bld.name, true) end, "Hospital"),
                supplies = {}
            }
            -- Access hospital contents for supply tracking
            if bld.contents then
                hospital.supplies = {
                    splints = {
                        current = safe_get(function() return bld.contents.count_splints end, 0),
                        desired = safe_get(function() return bld.contents.desired_splints end, 5)
                    },
                    crutches = {
                        current = safe_get(function() return bld.contents.count_crutches end, 0),
                        desired = safe_get(function() return bld.contents.desired_crutches end, 5)
                    },
                    thread = {
                        current = safe_get(function() return bld.contents.count_thread end, 0),
                        desired = safe_get(function() return bld.contents.desired_thread end, 75000)
                    },
                    cloth = {
                        current = safe_get(function() return bld.contents.count_cloth end, 0),
                        desired = safe_get(function() return bld.contents.desired_cloth end, 50000)
                    },
                    powder = {
                        current = safe_get(function() return bld.contents.count_powder end, 0),
                        desired = safe_get(function() return bld.contents.desired_powder end, 750)
                    },
                    buckets = {
                        current = safe_get(function() return bld.contents.count_buckets end, 0),
                        desired = safe_get(function() return bld.contents.desired_buckets end, 2)
                    },
                    soap = {
                        current = safe_get(function() return bld.contents.count_soap end, 0),
                        desired = safe_get(function() return bld.contents.desired_soap end, 750)
                    }
                }
            end
            table.insert(locations.hospitals, hospital)

        elseif df.abstract_building_inn_tavernst and df.abstract_building_inn_tavernst:is_instance(bld) then
            table.insert(locations.taverns, {
                name = safe_get(function() return translate_name(bld.name, false) end, "Tavern"),
                name_english = safe_get(function() return translate_name(bld.name, true) end, "Tavern")
            })

        elseif df.abstract_building_templest and df.abstract_building_templest:is_instance(bld) then
            table.insert(locations.temples, {
                name = safe_get(function() return translate_name(bld.name, false) end, "Temple"),
                name_english = safe_get(function() return translate_name(bld.name, true) end, "Temple")
            })

        elseif df.abstract_building_libraryst and df.abstract_building_libraryst:is_instance(bld) then
            table.insert(locations.libraries, {
                name = safe_get(function() return translate_name(bld.name, false) end, "Library"),
                name_english = safe_get(function() return translate_name(bld.name, true) end, "Library")
            })

        elseif df.abstract_building_guildhallst and df.abstract_building_guildhallst:is_instance(bld) then
            table.insert(locations.guildhalls, {
                name = safe_get(function() return translate_name(bld.name, false) end, "Guildhall"),
                name_english = safe_get(function() return translate_name(bld.name, true) end, "Guildhall")
            })
        end
    end

    return locations
end

local function get_mining_inventory()
    -- Inventory tables
    local stone_boulders = {}  -- key = stone name, value = count
    local metal_bars = {}      -- key = metal name, value = count
    local gems = {}            -- key = gem name, value = count
    local blocks = {}          -- key = material name, value = count

    -- Scan existing items in fortress
    for _, item in ipairs(df.global.world.items.all) do
        if not item.flags.garbage_collect and not item.flags.removed and
           not item.flags.trader and not item.flags.hostile and
           is_item_onsite(item) then

            local matinfo = dfhack.matinfo.decode(item)
            if matinfo then
                -- Get readable material name
                local mat_name = matinfo:toString()
                if not mat_name or mat_name == "" then
                    mat_name = safe_get(function() return matinfo.material.id end, "unknown")
                end

                if df.item_boulderst:is_instance(item) then
                    stone_boulders[mat_name] = (stone_boulders[mat_name] or 0) + 1
                elseif df.item_barst:is_instance(item) then
                    metal_bars[mat_name] = (metal_bars[mat_name] or 0) + 1
                elseif df.item_smallgemst:is_instance(item) then
                    gems[mat_name] = (gems[mat_name] or 0) + 1
                elseif df.item_blocksst:is_instance(item) then
                    blocks[mat_name] = (blocks[mat_name] or 0) + 1
                end
            end
        end
    end

    -- Use the prospect command to get vein data
    local ore_veins = {}       -- key = ore name, value = tile count
    local gem_deposits = {}    -- key = gem name, value = tile count

    -- Run prospect command silently and capture output
    local prospect_output, result = dfhack.run_command_silent('prospect')

    if prospect_output then
        -- Parse prospect output to extract ore and gem counts
        local in_ores_section = false
        local in_gems_section = false

        for line in prospect_output:gmatch("[^\n]+") do
            -- Detect section headers
            if line:match("^Ores:") then
                in_ores_section = true
                in_gems_section = false
            elseif line:match("^Gems:") then
                in_ores_section = false
                in_gems_section = true
            elseif line:match("^>>>") or (line:match("^[A-Za-z]") and not line:match("^%s+")) then
                -- End of sections (hit a total line or new section)
                in_ores_section = false
                in_gems_section = false
            end

            -- Parse material lines like: "             TETRAHEDRITE :       376   Elev:13..45"
            local material, count = line:match("^%s+([A-Z_]+)%s*:%s+(%d+)")
            if material and count then
                local mat_count = tonumber(count)
                if in_ores_section then
                    ore_veins[material:lower()] = mat_count
                elseif in_gems_section then
                    gem_deposits[material:lower()] = mat_count
                end
            end
        end
    end

    return {
        stone_boulders = stone_boulders,
        metal_bars = metal_bars,
        gems = gems,
        blocks = blocks,
        ore_veins = ore_veins,
        gem_deposits = gem_deposits
    }
end

local function format_mining_report(mining_data)
    if not mining_data then return "" end

    local lines = {}

    -- Helper to format material counts
    local function format_counts(tbl)
        if not tbl then return "none" end
        local items = {}
        for mat, num in pairs(tbl) do
            items[#items + 1] = num .. " " .. mat:lower()
        end
        if #items == 0 then return "none" end
        table.sort(items) -- Sort alphabetically for consistency
        return table.concat(items, ", ")
    end

    -- Stone boulders
    lines[#lines + 1] = "**Stone Boulders:** " .. format_counts(mining_data.stone_boulders)

    -- Metal bars
    lines[#lines + 1] = "**Metal Bars:** " .. format_counts(mining_data.metal_bars)

    -- Gems
    lines[#lines + 1] = "**Gems:** " .. format_counts(mining_data.gems)

    -- Blocks (if any)
    if mining_data.blocks and next(mining_data.blocks) then
        lines[#lines + 1] = "**Blocks:** " .. format_counts(mining_data.blocks)
    end

    -- Ore veins (top 10 by tile count)
    local ore_items = {}
    if mining_data.ore_veins then
        for ore, tiles in pairs(mining_data.ore_veins) do
            ore_items[#ore_items + 1] = {name = ore, tiles = tiles}
        end
        table.sort(ore_items, function(a, b) return a.tiles > b.tiles end)
    end
    if #ore_items > 0 then
        local ore_strs = {}
        for i = 1, math.min(10, #ore_items) do
            local display_name = ore_items[i].name:lower():gsub("_", " ")
            ore_strs[#ore_strs + 1] = display_name .. " (~" .. ore_items[i].tiles .. ")"
        end
        lines[#lines + 1] = "**Unmined Ore Veins (top 10):** " .. table.concat(ore_strs, ", ")
    else
        lines[#lines + 1] = "**Unmined Ore Veins:** none detected"
    end

    -- Gem deposits (top 10 by tile count)
    local gem_items = {}
    if mining_data.gem_deposits then
        for gem, tiles in pairs(mining_data.gem_deposits) do
            gem_items[#gem_items + 1] = {name = gem, tiles = tiles}
        end
        table.sort(gem_items, function(a, b) return a.tiles > b.tiles end)
    end
    if #gem_items > 0 then
        local gem_strs = {}
        for i = 1, math.min(10, #gem_items) do
            local display_name = gem_items[i].name:lower():gsub("_", " ")
            gem_strs[#gem_strs + 1] = display_name .. " (~" .. gem_items[i].tiles .. ")"
        end
        lines[#lines + 1] = "**Unmined Gem Deposits (top 10):** " .. table.concat(gem_strs, ", ")
    else
        lines[#lines + 1] = "**Unmined Gem Deposits:** none detected"
    end

    return table.concat(lines, "\n")
end

local function collect_state()
    local pop = analyze_population()
    local spokespersons = select_faction_spokespersons(pop.factions)

    return {
        date = get_date(),
        fortress = get_fortress_info(),
        population = pop,
        spokespersons = spokespersons,
        resources = get_resources(pop.total),
        trade_goods = get_trade_goods(),
        military = get_military(),
        defenses = get_defensive_structures(),
        buildings = get_buildings_summary(),
        zones = get_zones(),
        locations = get_locations(),
        events = get_fortress_history(),
        mining = get_mining_inventory()
    }
end

-- ============================================================
-- Briefing Generation
-- ============================================================

local function calculate_happiness(stress)
    local total = stress.joyous + stress.happy + stress.content + 
                  stress.fine + stress.unhappy + stress.stressed + stress.miserable
    if total == 0 then return 50 end
    
    local weighted = (stress.joyous * 100) + (stress.happy * 85) + 
                     (stress.content * 70) + (stress.fine * 50) +
                     (stress.unhappy * 30) + (stress.stressed * 15)
    return math.floor(weighted / total)
end

local function identify_concerns(state)
    local concerns = {}
    local pop = state.population
    local res = state.resources
    
    if res.food.status == "critical" then
        table.insert(concerns, "!! CRITICAL: Food supplies dangerously low!")
    end
    if res.drink.status == "critical" then
        table.insert(concerns, "!! CRITICAL: Alcohol supplies critical!")
    end
    if pop.stress.miserable > 0 then
        table.insert(concerns, "! WARNING: " .. plural(pop.stress.miserable, "dwarf", "dwarves") .. 
                     " in miserable state - tantrum risk!")
    end
    if pop.stress.stressed > 3 then
        table.insert(concerns, "! CAUTION: " .. plural(pop.stress.stressed, "dwarf", "dwarves") .. 
                     " with high stress")
    end
    if pop.military == 0 and pop.total > 20 then
        table.insert(concerns, "! DEFENSE: No military - cooperative is defenseless!")
    end
    
    for _, evt in ipairs(state.events) do
        if evt.type == "SIEGE" and evt.text:find("arrived") then
            table.insert(concerns, "!! ALERT: Siege detected!")
            break
        end
    end
    
    return concerns
end

local function generate_briefing(state)
    local date = state.date
    local fort = state.fortress
    local pop = state.population
    local res = state.resources
    local mil = state.military
    local bld = state.buildings
    
    local happiness = calculate_happiness(pop.stress)
    local concerns = identify_concerns(state)
    local positive = pop.stress.joyous + pop.stress.happy
    local neutral = pop.stress.unhappy + pop.stress.fine + pop.stress.content
    local negative = pop.stress.stressed + pop.stress.miserable
    
    local lines = {
        "# Dwarven Cooperative " .. fort.name_english,
        "## General Assembly - " .. date.day .. " " .. date.month_name .. ", Year " .. date.year .. " (" .. date.season .. ")",
        "",
        "---",
        ""
    }
    
    -- Eligible voters
    table.insert(lines, "## Assembly Quorum")
    table.insert(lines, string.format("**Total members:** %d dwarves", pop.total))
    table.insert(lines, string.format("**Eligible voters:** %d adults (children: %d)",
        pop.eligible_voters, pop.children))
    table.insert(lines, string.format("**Quorum:** %d votes required for decision (50%%+1)",
        math.floor(pop.eligible_voters / 2) + 1))
    table.insert(lines, "")

    -- Factions with spokespersons
    table.insert(lines, "## Faction Distribution & Spokespersons")
    local sorted_factions = {}
    for id, data in pairs(pop.factions) do
        if data.members > 0 then
            table.insert(sorted_factions, {id = id, name = data.name, members = data.members})
        end
    end
    table.sort(sorted_factions, function(a, b) return a.members > b.members end)

    for _, f in ipairs(sorted_factions) do
        local pct_val = pct(f.members, pop.eligible_voters)
        local bar_len = math.floor((f.members / pop.eligible_voters) * 20)
        local bar = string.rep("#", bar_len) .. string.rep("-", 20 - bar_len)
        table.insert(lines, string.format("  %s %s: %d votes (%s)",
            bar, f.name, f.members, pct_val))

        -- Add spokesperson info
        local spokesperson = state.spokespersons[f.id]
        if spokesperson then
            local personality_str = ""
            if #spokesperson.personality > 0 then
                personality_str = " (" .. table.concat(spokesperson.personality, ", ") .. ")"
            end
            table.insert(lines, string.format("    Spokesperson: %s, %s%s",
                spokesperson.name, spokesperson.profession, personality_str))
        end
    end
    table.insert(lines, "")
    
    -- Concerns
    if #concerns > 0 then
        table.insert(lines, "## Urgent Agenda Items")
        for _, c in ipairs(concerns) do
            table.insert(lines, c)
        end
        table.insert(lines, "")
    end

    -- Status
    table.insert(lines, "## Cooperative Status")
    table.insert(lines, string.format("**Workforce:** %d active, %d in militia, %d injured",
        pop.adults - pop.military - pop.injured, pop.military, pop.injured))
    table.insert(lines, string.format("**Morale:** %d%% satisfaction", happiness))
    table.insert(lines, string.format("  - Positive mood: %d members (%s)", positive, pct(positive, pop.total)))
    table.insert(lines, string.format("  - Neutral: %d members (%s)", neutral, pct(neutral, pop.total)))
    local neg_warn = negative > (pop.total / 5) and " !" or ""
    table.insert(lines, string.format("  - Negative mood: %d members (%s)%s", negative, pct(negative, pop.total), neg_warn))
    table.insert(lines, "")
    
    -- Resources with diversity breakdown
    table.insert(lines, "## Common Resources")
    table.insert(lines, string.format("**Food:** %s %s (%d units, ~%d days supply)",
        status_indicator(res.food.status), res.food.status, res.food.count, res.food.days_of_supply))

    -- Food diversity breakdown
    local food_breakdown = {}
    for food_type, count in pairs(res.food.types) do
        if count > 0 then
            table.insert(food_breakdown, string.format("%s: %d", food_type, count))
        end
    end
    if #food_breakdown > 0 then
        table.insert(lines, "  - " .. table.concat(food_breakdown, ", "))
    end

    table.insert(lines, string.format("**Drink:** %s %s (%d units, ~%d days supply)",
        status_indicator(res.drink.status), res.drink.status, res.drink.count, res.drink.days_of_supply))

    -- Drink diversity breakdown
    local drink_breakdown = {}
    for drink_type, count in pairs(res.drink.types) do
        if count > 0 then
            table.insert(drink_breakdown, string.format("%s: %d", drink_type, count))
        end
    end
    if #drink_breakdown > 0 then
        table.insert(lines, "  - " .. table.concat(drink_breakdown, ", "))
    end

    table.insert(lines, string.format("**Accumulated wealth:** %d ☐ (total value of fortress assets)", res.wealth.total))

    -- Trade goods (fortress-made items suitable for trading)
    local tg = state.trade_goods
    local trade_items = {}
    if tg.artifacts > 0 then
        table.insert(trade_items, string.format("%d artifact%s", tg.artifacts, tg.artifacts > 1 and "s" or ""))
    end
    if tg.masterworks > 0 then
        table.insert(trade_items, string.format("%d masterwork%s", tg.masterworks, tg.masterworks > 1 and "s" or ""))
    end
    if tg.gems_cut > 0 then
        table.insert(trade_items, string.format("%d cut gem%s", tg.gems_cut, tg.gems_cut > 1 and "s" or ""))
    end
    if tg.crafts > 0 then
        table.insert(trade_items, string.format("%d fine craft%s", tg.crafts, tg.crafts > 1 and "s" or ""))
    end
    if #trade_items > 0 then
        -- Format value with thousands separators for readability
        local value_str = tostring(tg.total_value):reverse():gsub("(%d%d%d)", "%1,"):reverse():gsub("^,", "")
        table.insert(lines, string.format("**Fortress-made trade goods:** %s (est. value: %s ☼)",
            table.concat(trade_items, ", "), value_str))
    end
    table.insert(lines, "")

    -- Mining Inventory
    if state.mining then
        table.insert(lines, "## Mining Inventory")
        table.insert(lines, format_mining_report(state.mining))
        table.insert(lines, "")
    end

    -- Military
    table.insert(lines, "## Collective Defense")
    local strength = "none"
    if pop.military > 0 then
        local ratio = pop.military / pop.total
        if ratio >= 0.3 then strength = "fortress"
        elseif ratio >= 0.2 then strength = "strong"
        elseif ratio >= 0.1 then strength = "adequate"
        else strength = "minimal" end
    end
    table.insert(lines, string.format("**Militia:** %s (%d members, %s of cooperative)",
        strength, pop.military, pct(pop.military, pop.total)))

    -- Detailed squad information with equipment and skills
    if mil.squads and #mil.squads > 0 then
        for _, squad in ipairs(mil.squads) do
            table.insert(lines, string.format("  - **%s**: %d members", squad.name, #squad.members))

            for _, member in ipairs(squad.members) do
                table.insert(lines, string.format("    - %s", member.name))

                -- Equipment
                local equipment_parts = {}
                if member.equipment.weapon ~= "none" then
                    table.insert(equipment_parts, "Weapon: " .. member.equipment.weapon)
                end
                if member.equipment.shield ~= "none" then
                    table.insert(equipment_parts, "Shield: " .. member.equipment.shield)
                end
                if #member.equipment.armor > 0 then
                    table.insert(equipment_parts, "Armor: " .. #member.equipment.armor .. " pieces")
                end

                if #equipment_parts > 0 then
                    table.insert(lines, "      Equipment: " .. table.concat(equipment_parts, ", "))
                else
                    table.insert(lines, "      Equipment: none")
                end

                -- Skills
                local skill_parts = {}
                if member.skills.weapon ~= "none" then
                    table.insert(skill_parts, member.skills.weapon)
                end
                table.insert(skill_parts, "Fighting: " .. member.skills.fighter)
                table.insert(skill_parts, "Dodging: " .. member.skills.dodger)

                table.insert(lines, "      Skills: " .. table.concat(skill_parts, ", "))
            end
        end
    elseif pop.military > 0 then
        table.insert(lines, "  - (No squad details available)")
    end

    table.insert(lines, "")

    -- Defensive structures
    local def = state.defenses
    table.insert(lines, "**Defensive Structures:**")

    local def_items = {}
    if def.fortifications > 0 then
        table.insert(def_items, string.format("Fortifications: %d", def.fortifications))
    end
    if def.walls > 0 then
        table.insert(def_items, string.format("Walls: %d", def.walls))
    end
    if def.traps > 0 then
        local trap_details = {}
        if def.cage_traps > 0 then table.insert(trap_details, def.cage_traps .. " cage") end
        if def.weapon_traps > 0 then table.insert(trap_details, def.weapon_traps .. " weapon") end
        if def.stone_traps > 0 then table.insert(trap_details, def.stone_traps .. " stone-fall") end

        if #trap_details > 0 then
            table.insert(def_items, string.format("Traps: %d (%s)", def.traps, table.concat(trap_details, ", ")))
        else
            table.insert(def_items, string.format("Traps: %d", def.traps))
        end
    end
    if def.bridges > 0 then
        table.insert(def_items, string.format("Bridges: %d", def.bridges))
    end

    if #def_items > 0 then
        table.insert(lines, "  - " .. table.concat(def_items, ", "))
    else
        table.insert(lines, "  - none")
    end

    table.insert(lines, "")
    
    -- Infrastructure
    table.insert(lines, "## Common Infrastructure")
    table.insert(lines, string.format("**Production:** %d workshops, %d furnaces", bld.workshops, bld.furnaces))

    -- Workshop types breakdown
    if bld.workshops > 0 then
        local workshop_list = {}
        for wtype, count in pairs(bld.workshop_types) do
            table.insert(workshop_list, string.format("%s: %d", wtype, count))
        end
        if #workshop_list > 0 then
            table.insert(lines, "  - Workshops: " .. table.concat(workshop_list, ", "))
        end
    end

    -- Furnace types breakdown
    if bld.furnaces > 0 then
        local furnace_list = {}
        for ftype, count in pairs(bld.furnace_types) do
            table.insert(furnace_list, string.format("%s: %d", ftype, count))
        end
        if #furnace_list > 0 then
            table.insert(lines, "  - Furnaces: " .. table.concat(furnace_list, ", "))
        end
    end

    table.insert(lines, string.format("**Housing:** %d beds, %d tables, %d chairs",
        bld.beds, bld.tables, bld.chairs))

    -- Zones
    local zones = state.zones
    local zones_summary = {}
    if zones.bedrooms > 0 then
        table.insert(zones_summary, string.format("%d bedrooms", zones.bedrooms))
    end
    if zones.dining_halls > 0 then
        table.insert(zones_summary, string.format("%d dining halls", zones.dining_halls))
    end
    if zones.meeting_areas > 0 then
        table.insert(zones_summary, string.format("%d meeting areas", zones.meeting_areas))
    end
    if zones.barracks > 0 then
        table.insert(zones_summary, string.format("%d barracks", zones.barracks))
    end
    if zones.pens and zones.pens > 0 then
        table.insert(zones_summary, string.format("%d animal pens", zones.pens))
    end
    if zones.tombs and zones.tombs > 0 then
        table.insert(zones_summary, string.format("%d tombs", zones.tombs))
    end
    if #zones_summary > 0 then
        table.insert(lines, string.format("**Zones:** %s", table.concat(zones_summary, ", ")))
    end

    -- Locations (hospitals, taverns, temples, libraries, guildhalls)
    local locs = state.locations
    if locs then
        -- Hospitals with supply details
        if #locs.hospitals > 0 then
            for _, hosp in ipairs(locs.hospitals) do
                table.insert(lines, string.format("**Hospital:** %s", hosp.name))
                -- Check for supply shortages
                local shortages = {}
                local stocked = {}
                if hosp.supplies then
                    for supply_name, supply_data in pairs(hosp.supplies) do
                        if supply_data.current < supply_data.desired then
                            table.insert(shortages, string.format("%s: %d/%d",
                                supply_name, supply_data.current, supply_data.desired))
                        else
                            table.insert(stocked, supply_name)
                        end
                    end
                end
                if #shortages > 0 then
                    table.insert(lines, "  - Shortages: " .. table.concat(shortages, ", "))
                else
                    table.insert(lines, "  - Fully stocked")
                end
            end
        end

        -- Taverns
        if #locs.taverns > 0 then
            local tavern_names = {}
            for _, t in ipairs(locs.taverns) do
                table.insert(tavern_names, t.name)
            end
            table.insert(lines, string.format("**Taverns:** %s", table.concat(tavern_names, ", ")))
        end

        -- Temples
        if #locs.temples > 0 then
            local temple_names = {}
            for _, t in ipairs(locs.temples) do
                table.insert(temple_names, t.name)
            end
            table.insert(lines, string.format("**Temples:** %s", table.concat(temple_names, ", ")))
        end

        -- Libraries
        if #locs.libraries > 0 then
            local lib_names = {}
            for _, l in ipairs(locs.libraries) do
                table.insert(lib_names, l.name)
            end
            table.insert(lines, string.format("**Libraries:** %s", table.concat(lib_names, ", ")))
        end

        -- Guildhalls
        if #locs.guildhalls > 0 then
            local guild_names = {}
            for _, g in ipairs(locs.guildhalls) do
                table.insert(guild_names, g.name)
            end
            table.insert(lines, string.format("**Guildhalls:** %s", table.concat(guild_names, ", ")))
        end
    end

    -- Offices with assignments
    if zones.offices and #zones.offices > 0 then
        local office_list = {}
        for _, office in ipairs(zones.offices) do
            if #office.positions > 0 then
                table.insert(office_list, string.format("%s (%s)",
                    office.owner_name, table.concat(office.positions, ", ")))
            else
                table.insert(office_list, office.owner_name)
            end
        end
        table.insert(lines, string.format("**Offices:** %s", table.concat(office_list, "; ")))
    end

    table.insert(lines, "")

    -- Events with dates
    if #state.events > 0 then
        table.insert(lines, "## Fortress Chronicle")
        table.insert(lines, "")

        -- Group events by importance
        local high_importance = {}
        local other_events = {}

        for _, evt in ipairs(state.events) do
            if evt.importance == "high" then
                table.insert(high_importance, evt)
            else
                table.insert(other_events, evt)
            end
        end

        -- Show high-importance events first
        if #high_importance > 0 then
            table.insert(lines, "**Notable Events:**")
            for _, evt in ipairs(high_importance) do
                local date_str = evt.date and format_date_string(evt.date, evt.year_only) or "Unknown date"
                table.insert(lines, string.format("  - [%s] %s", date_str, evt.text))
            end
            table.insert(lines, "")
        end

        -- Show other recent events
        if #other_events > 0 then
            table.insert(lines, "**Recent Activity:**")
            for i, evt in ipairs(other_events) do
                if i > 10 then break end  -- Limit other events
                local date_str = evt.date and format_date_string(evt.date, evt.year_only) or "Unknown date"
                table.insert(lines, string.format("  - [%s] %s", date_str, evt.text))
            end
        end
    end

    return table.concat(lines, "\n")
end

-- ============================================================
-- Commands
-- ============================================================

local function cmd_status()
    local state = collect_state()
    local pop = state.population
    local happiness = calculate_happiness(pop.stress)
    
    print(string.format(
        "=== Coop %s | Year %d %s | Members: %d (voters: %d) | Food: %s | Drink: %s | Morale: %d%% ===",
        state.fortress.name_english, state.date.year, state.date.season,
        pop.total, pop.eligible_voters,
        state.resources.food.status, state.resources.drink.status, happiness
    ))
end

local function cmd_briefing()
    print("[Assembly] Secretariat gathering data...")
    local state = collect_state()
    local briefing = generate_briefing(state)
    print("")
    print(briefing)
end

local function cmd_members()
    local state = collect_state()
    local pop = state.population
    
    print("+============================================================+")
    print("|              MEMBER REGISTRY - DWARVEN COOPERATIVE         |")
    print("+============================================================+")
    print("")
    print(string.format("Total members: %d | Eligible voters: %d | Children: %d",
        pop.total, pop.eligible_voters, pop.children))
    print(string.format("Quorum for decisions: %d votes", 
        math.floor(pop.eligible_voters / 2) + 1))
    print("")
    print("Faction distribution:")
    print("-------------------------------------------------------------")
    
    local sorted = {}
    for id, data in pairs(pop.factions) do
        table.insert(sorted, {id = id, name = data.name, members = data.members})
    end
    table.sort(sorted, function(a, b) return a.members > b.members end)
    
    for _, f in ipairs(sorted) do
        local pct_val = pct(f.members, pop.eligible_voters)
        local bar_len = math.floor((f.members / pop.eligible_voters) * 30)
        local bar = string.rep("#", bar_len) .. string.rep("-", 30 - bar_len)
        print(string.format("%s %3d votes (%5s) %s", bar, f.members, pct_val, f.name))
    end
end

local function cmd_assembly()
    local state = collect_state()
    local briefing = generate_briefing(state)

    -- df.unit userdata cannot be JSON-encoded and nothing downstream needs it
    for _, faction in pairs(state.population.factions) do
        faction.dwarves = nil
    end

    local payload = json.encode({ schema = 1, state = state, briefing = briefing }, { pretty = false })
    print("===DWARVEN_ASSEMBLY_STATE_JSON===")
    print(#payload)
    print(payload)
    print("===DWARVEN_ASSEMBLY_STATE_END===")
end

-- ============================================================
-- Entry Point
-- ============================================================

local args = argparse.processArgsGetopt({...}, {})
local command = args[1] or "help"

if command == "assembly" then
    cmd_assembly()
elseif command == "briefing" then
    cmd_briefing()
elseif command == "status" then
    cmd_status()
elseif command == "members" then
    cmd_members()
else
    print("Dwarven Cooperative - Democratic Dwarf Fortress")
    print("")
    print("Usage:")
    print("  dwarven-coop assembly   - Hold the General Assembly")
    print("  dwarven-coop briefing   - Show cooperative status")
    print("  dwarven-coop status     - Quick status line")
    print("  dwarven-coop members    - Show member registry by faction")
    print("")
    print("The dwarves have organized themselves as a cooperative.")
    print("Every adult dwarf has 1 vote in the General Assembly.")
end
