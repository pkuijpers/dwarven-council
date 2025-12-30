-- dwarven-coop.lua
-- Dwarven Cooperative addon - democratic decision-making via General Assembly
-- Place in: <DF>/hack/scripts/
--
-- Usage:
--   dwarven-coop assembly   - Hold the General Assembly (generates OKRs)
--   dwarven-coop briefing   - Show current fortress status
--   dwarven-coop status     - Quick status check
--   dwarven-coop members    - Show voting members by faction
--
-- The dwarves have organized themselves as a cooperative.
-- Each quarter the General Assembly convenes. All adult dwarves have 1 vote.

local argparse = require('argparse')
local utils = require('utils')

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

local function print_llm_prompt(system_prompt, user_prompt)
    -- Combine system and user prompts for standard chat UIs
    local combined_prompt = system_prompt .. "\n\n" .. user_prompt
    print(combined_prompt)
end

-- ============================================================
-- Factions within the Cooperative
-- ============================================================

-- Dwarves are assigned to factions based on their profession
local FACTIONS = {
    {
        id = "producers",
        name = "Producers Collective",
        description = "Craftsdwarves, smiths, and makers",
        priorities = {"workshop efficiency", "masterwork creation", "tool quality"},
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
        description = "Farmers, cooks, and brewers",
        priorities = {"food security", "alcohol production", "sustainable farming"},
        professions = {
            "FARMER", "COOK", "BREWER", "BUTCHER", "TANNER",
            "CHEESE_MAKER", "MILKER", "HERBALIST", "THRESHER",
            "MILLER", "FISH_CLEANER", "FISHERMAN", "PRESSER"
        }
    },
    {
        id = "delvers",
        name = "Delvers Guild",
        description = "Miners and earthworkers",
        priorities = {"expansion", "ore discovery", "safe mining", "megaprojects"},
        professions = {
            "MINER", "ENGRAVER", "MECHANIC", "ENGINEER",
            "PUMP_OPERATOR", "GELDER"
        }
    },
    {
        id = "defenders",
        name = "Defenders Union",
        description = "Military and guards",
        priorities = {"fortress defense", "military training", "equipment quality"},
        professions = {
            "WRESTLER", "AXE", "SWORD", "MACE", "HAMMER",
            "SPEAR", "CROSSBOW", "SHIELD", "ARMOR", "WEAPONUSER",
            "RECRUIT", "HUNTER", "MARKSDWARF", "WRESTLER"
        }
    },
    {
        id = "caregivers",
        name = "Care Collective",
        description = "Medics and welfare workers",
        priorities = {"healthcare", "mental wellness", "injury prevention", "quality of life"},
        professions = {
            "DOCTOR", "DIAGNOSER", "BONE_SETTER", "SURGEON",
            "SUTURER", "CHIEF_MEDICAL_DWARF", "ANIMAL_CARETAKER"
        }
    },
    {
        id = "services",
        name = "Services Sector",
        description = "Traders, administrators, and others",
        priorities = {"trade relations", "efficient management", "diplomacy"},
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
        [0] = "joyous", [1] = "happy", [2] = "content", [3] = "fine",
        [4] = "unhappy", [5] = "stressed", [6] = "miserable"
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

local function get_resources()
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

    for _, item in ipairs(df.global.world.items.all) do
        -- Filter out items that aren't ours or aren't available
        if not item.flags.trader and
           not item.flags.hostile and
           not item.flags.removed and
           not item.flags.forbid and
           not item.flags.dump then

            if df.item_foodst:is_instance(item) then
                -- Prepared meals can be stacked
                local size = item.stack_size
                local count = (size > 0) and size or 1
                food_count = food_count + count
                food_types.prepared_meals = food_types.prepared_meals + count
            elseif df.item_fishst:is_instance(item) or df.item_fish_rawst:is_instance(item) then
                -- Fish are individual items, not stacked
                food_count = food_count + 1
                food_types.fish = food_types.fish + 1
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
    
    local function status_for_count(count)
        if count > 200 then return "abundant"
        elseif count > 100 then return "adequate"
        elseif count > 50 then return "low"
        else return "critical" end
    end

    return {
        food = {
            count = food_count,
            status = status_for_count(food_count),
            types = food_types
        },
        drink = {
            count = drink_count,
            status = status_for_count(drink_count),
            types = drink_types
        },
        wealth = {
            total = safe_get(function() return df.global.plotinfo.wealth.total end, 0),
            created = safe_get(function() return df.global.plotinfo.wealth.created end, 0),
            imported = safe_get(function() return df.global.plotinfo.wealth.imported end, 0)
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
           not item.flags.in_building then

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

local function get_military()
    local squads = {}
    local plotinfo_id = df.global.plotinfo.group_id
    
    for _, squad in ipairs(df.global.world.squads.all) do
        if squad.entity_id == plotinfo_id then
            local member_count = 0
            for _, pos in ipairs(squad.positions) do
                if pos.occupant ~= -1 then
                    member_count = member_count + 1
                end
            end
            if member_count > 0 then
                table.insert(squads, {
                    name = translate_name(squad.name, false),
                    members = member_count
                })
            end
        end
    end
    
    return { squad_count = #squads, squads = squads }
end

local function get_recent_events()
    local events = {}
    local current_tick = df.global.cur_year_tick
    local lookback = 1200 * 28 * 3
    
    local important_types = {
        CARAVAN = true, DIPLOMAT = true, SIEGE = true, AMBUSH = true,
        BIRTH = true, DEATH = true, ARTIFACT = true, MASTERPIECE = true,
        STRANGE_MOOD = true, MEGABEAST = true, MANDATE = true, MIGRANT = true
    }
    
    for i = #df.global.world.status.announcements - 1, 0, -1 do
        local ann = df.global.world.status.announcements[i]
        if ann.year == df.global.cur_year then
            local age = current_tick - ann.time
            if age >= 0 and age < lookback then
                local type_name = df.announcement_type[ann.type] or "OTHER"
                if important_types[type_name] then
                    table.insert(events, { text = ann.text, type = type_name })
                end
            end
        end
        if #events >= 15 then break end
    end
    
    return events
end

local function get_zones()
    local zones = {
        bedrooms = 0,
        dining_halls = 0,
        meeting_areas = 0,
        hospitals = 0,
        barracks = 0,
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
            elseif zone_type == df.civzone_type.Hospital then
                zones.hospitals = zones.hospitals + 1
            elseif zone_type == df.civzone_type.Barracks then
                zones.barracks = zones.barracks + 1
            else
                zones.other = zones.other + 1
            end
        end
    end

    return zones
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
           not item.flags.trader and not item.flags.hostile then

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
        resources = get_resources(),
        trade_goods = get_trade_goods(),
        military = get_military(),
        buildings = get_buildings_summary(),
        zones = get_zones(),
        events = get_recent_events(),
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
    local positive = pop.stress.joyous + pop.stress.happy + pop.stress.content
    local negative = pop.stress.unhappy + pop.stress.stressed + pop.stress.miserable
    
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
    table.insert(lines, string.format("  - Neutral: %d members (%s)", pop.stress.fine, pct(pop.stress.fine, pop.total)))
    local neg_warn = negative > (pop.total / 5) and " !" or ""
    table.insert(lines, string.format("  - Negative mood: %d members (%s)%s", negative, pct(negative, pop.total), neg_warn))
    table.insert(lines, "")
    
    -- Resources with diversity breakdown
    table.insert(lines, "## Common Resources")
    table.insert(lines, string.format("**Food:** %s %s (%d units total)",
        status_indicator(res.food.status), res.food.status, res.food.count))

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

    table.insert(lines, string.format("**Drink:** %s %s (%d units total)",
        status_indicator(res.drink.status), res.drink.status, res.drink.count))

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
    for _, squad in ipairs(mil.squads) do
        table.insert(lines, string.format("  - %s: %d members", squad.name, squad.members))
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
    if zones.hospitals > 0 then
        table.insert(zones_summary, string.format("%d hospitals", zones.hospitals))
    end
    if zones.barracks > 0 then
        table.insert(zones_summary, string.format("%d barracks", zones.barracks))
    end
    if #zones_summary > 0 then
        table.insert(lines, string.format("**Zones:** %s", table.concat(zones_summary, ", ")))
    end

    table.insert(lines, "")
    
    -- Events
    if #state.events > 0 then
        table.insert(lines, "## Recent Events")
        for _, evt in ipairs(state.events) do
            table.insert(lines, string.format("  - [%s] %s", evt.type, evt.text))
        end
    end
    
    return table.concat(lines, "\n")
end

-- ============================================================
-- LLM Integration
-- ============================================================

local function build_system_prompt(state)
    local pop = state.population
    
    -- Build faction information
    local faction_lines = {}
    for _, faction in ipairs(FACTIONS) do
        local data = pop.factions[faction.id]
        if data and data.members > 0 then
            table.insert(faction_lines, string.format(
                "- **%s** (%d votes, %s): %s. Priorities: %s",
                faction.name,
                data.members,
                pct(data.members, pop.eligible_voters),
                faction.description,
                table.concat(faction.priorities, ", ")
            ))
        end
    end
    
    return [[You are simulating the General Assembly of a Dwarven Cooperative in Dwarf Fortress.

## Organizational Structure
The dwarves have organized themselves as a cooperative. Key principles:
- **Democratic:** Every adult dwarf has 1 vote
- **Collective ownership:** All resources are common property
- **Solidarity:** Decisions are made in the interest of all members

## Voting Factions
]] .. table.concat(faction_lines, "\n") .. [[

## Assembly Procedure
1. Opening by the chairperson (elected from the largest faction)
2. Establishment of quorum (50%+1 of eligible voters)
3. Discussion of agenda items - factions submit proposals
4. Debate between factions (show different perspectives)
5. Voting on OKRs (show vote distributions)
6. Adoption of final OKRs

## Output Format

### [OPENING] Opening Assembly
[Brief opening, establishment of quorum]

### [POSITIONS] Faction Positions
[Each relevant faction briefly presents their priorities]

### [DEBATE] Debate
[Brief debate between factions - disagreements and compromises]

### [VOTING] Voting

#### Motion 1: [Objective title]
Submitted by: [Faction]
- KR1: [Measurable key result]
- KR2: [Measurable key result]  
- KR3: [Measurable key result]

**Vote Result:**
- For: [X] votes ([factions])
- Against: [Y] votes ([factions])
- Abstain: [Z] votes
- [PASS] ADOPTED / [FAIL] REJECTED

[Repeat for each motion - usually 3-4 motions]

### [NOTE] Minutes
[Brief summary and advice for the player]

## Guidelines
- OKRs must be achievable within one season
- Key Results are specific and measurable
- Show realistic faction dynamics (sometimes conflict, sometimes consensus)
- Larger factions have more influence but small factions can form coalitions
- Address urgent concerns first
- Balance short-term survival with long-term growth]]
end

local function build_user_prompt(state, briefing)
    local pop = state.population
    local available = pop.adults - pop.military - pop.injured
    
    local focus_areas = {}
    local happiness = calculate_happiness(pop.stress)
    
    if happiness < 50 then table.insert(focus_areas, "Morale improvement") end
    if state.resources.food.status == "low" or state.resources.food.status == "critical" then
        table.insert(focus_areas, "Food production")
    end
    if state.resources.drink.status == "low" or state.resources.drink.status == "critical" then
        table.insert(focus_areas, "Alcohol production")
    end
    if pop.military < (pop.total / 10) then
        table.insert(focus_areas, "Collective defense")
    end
    table.insert(focus_areas, "Wealth building")
    table.insert(focus_areas, "Infrastructure")
    
    local prompt = "# General Assembly - Quarterly Meeting\n\n"
    prompt = prompt .. briefing .. "\n\n"
    prompt = prompt .. "## Assembly Context\n"
    prompt = prompt .. "Available workforce: " .. available .. " dwarves\n"
    prompt = prompt .. "Quorum: " .. (math.floor(pop.eligible_voters / 2) + 1) .. " votes\n"
    prompt = prompt .. "Suggested focus areas: " .. table.concat(focus_areas, ", ") .. "\n\n"
    prompt = prompt .. "Conduct the General Assembly and produce the OKRs for the coming quarter through democratic voting."
    
    return prompt
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
    print("+============================================================+")
    print("|       DWARVEN COOPERATIVE - GENERAL ASSEMBLY               |")
    print("|                   Quarterly Meeting                        |")
    print("+============================================================+")
    print("")
    
    local state = collect_state()
    local briefing = generate_briefing(state)
    local system_prompt = build_system_prompt(state)
    local user_prompt = build_user_prompt(state, briefing)

    -- Print the prompt for manual copy/paste to LLM
    print_llm_prompt(system_prompt, user_prompt)
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
