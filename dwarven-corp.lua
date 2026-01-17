-- dwarven-corp.lua
-- Dwarven Corporation - Modern Corporate Governance for Dwarf Fortress
-- Place in: <DF>/hack/scripts/
--
-- Usage:
--   dwarven-corp qbr        - Quarterly Business Review (generates OKRs)
--   dwarven-corp dashboard  - Executive dashboard
--   dwarven-corp org        - Org chart with headcount by department
--   dwarven-corp status     - Quick status
--
-- "Synergizing Vertical Integration Across the Mountain"
-- A Fortune 500 Fortress

local json = require('json')
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
        furnaces = 0,
        beds = 0,
        tables = 0,
        chairs = 0
    }

    for _, bld in ipairs(df.global.world.buildings.all) do
        local btype = bld:getType()
        if btype == df.building_type.Workshop then
            counts.workshops = counts.workshops + 1
        elseif btype == df.building_type.Furnace then
            counts.furnaces = counts.furnaces + 1
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
-- Configuration
-- ============================================================

local CONFIG = {
    api_key = os.getenv("ANTHROPIC_API_KEY") or "your-api-key-here",
    model = "claude-sonnet-4-20250514",
    api_url = "https://api.anthropic.com/v1/messages",
    output_dir = "/tmp/dwarven-corp",
}

-- Create output directory using DFHack filesystem API
dfhack.filesystem.mkdir_recursive(CONFIG.output_dir)

-- ============================================================
-- Corporate Structure
-- ============================================================

-- The C-Suite
local C_SUITE = {
    {
        title = "CEO",
        full_title = "Chief Executive Officer",
        name_suffix = "the Visionary",
        responsibility = "Overall strategy and shareholder value",
        buzzwords = {"north star", "big picture", "move the needle", "paradigm shift"},
        personality = "Speaks only in vague inspirational statements. Never answers directly."
    },
    {
        title = "COO",
        full_title = "Chief Operating Officer",
        responsibility = "Day-to-day operations and execution",
        buzzwords = {"operational excellence", "streamline", "bandwidth", "deliverables"},
        personality = "Obsessed with processes. Has a flowchart for everything."
    },
    {
        title = "CFO",
        full_title = "Chief Financial Officer",
        responsibility = "Financial planning and wealth management",
        buzzwords = {"runway", "burn rate", "ROI", "cost center", "EBITDA"},
        personality = "Sees everything as a spreadsheet. Questions every expense."
    },
    {
        title = "CHRO",
        full_title = "Chief Human Resources Officer",
        responsibility = "Talent acquisition and culture",
        buzzwords = {"human capital", "talent pipeline", "culture fit", "engagement"},
        personality = "Insists the company is 'a family'. Plans mandatory fun activities."
    },
    {
        title = "CTO",
        full_title = "Chief Technology Officer",
        responsibility = "Workshop innovation and R&D",
        buzzwords = {"disruptive", "cutting-edge", "tech stack", "scalable", "leverage"},
        personality = "Wants to rewrite everything from scratch. Dismisses legacy systems."
    },
    {
        title = "CSO",
        full_title = "Chief Security Officer",
        responsibility = "Defense and risk management",
        buzzwords = {"threat landscape", "attack surface", "zero trust", "defense in depth"},
        personality = "Paranoid. Assumes every caravan is a potential breach."
    }
}

-- Business Units (mapped from professions)
local BUSINESS_UNITS = {
    {
        id = "manufacturing",
        name = "Manufacturing & Production",
        code = "MFG",
        professions = {
            "CRAFTSMAN", "WOODWORKER", "STONEWORKER", "METALSMITH", 
            "JEWELER", "CRAFTSDWARF", "MASON", "CARPENTER", 
            "GLASSMAKER", "POTTER", "WEAPONSMITH", "ARMORER", 
            "BLACKSMITH", "BOWYER", "STRAND_EXTRACTOR"
        }
    },
    {
        id = "mining",
        name = "Resource Extraction",
        code = "REX",
        professions = {
            "MINER", "ENGRAVER", "MECHANIC", "ENGINEER", "PUMP_OPERATOR"
        }
    },
    {
        id = "food",
        name = "Food & Beverage Division",
        code = "F&B",
        professions = {
            "FARMER", "COOK", "BREWER", "BUTCHER", "TANNER",
            "CHEESE_MAKER", "MILKER", "HERBALIST", "THRESHER",
            "MILLER", "FISH_CLEANER", "FISHERMAN", "PRESSER"
        }
    },
    {
        id = "defense",
        name = "Corporate Security",
        code = "SEC",
        professions = {
            "WRESTLER", "AXE", "SWORD", "MACE", "HAMMER",
            "SPEAR", "CROSSBOW", "SHIELD", "RECRUIT", "HUNTER", "MARKSDWARF"
        }
    },
    {
        id = "medical",
        name = "Health & Wellness",
        code = "H&W",
        professions = {
            "DOCTOR", "DIAGNOSER", "BONE_SETTER", "SURGEON",
            "SUTURER", "CHIEF_MEDICAL_DWARF", "ANIMAL_CARETAKER"
        }
    },
    {
        id = "operations",
        name = "Operations & Logistics",
        code = "OPS",
        professions = {
            "TRADER", "BROKER", "CLERK", "ADMINISTRATOR",
            "MANAGER", "BOOKKEEPER", "HAULER", "PEASANT"
        }
    }
}

-- Corporate Values (for the mission statement)
local CORE_VALUES = {
    "Innovation Through Excavation",
    "Sustainable Magma Practices",
    "Dwarf-Centric Design",
    "Operational Excellence Underground",
    "Shareholder Value Creation"
}

-- ============================================================
-- Utility Functions
-- ============================================================




local function format_number(n)
    if n >= 1000000 then
        return string.format("%.1fM", n / 1000000)
    elseif n >= 1000 then
        return string.format("%.1fK", n / 1000)
    else
        return tostring(n)
    end
end


local function trend_indicator(current, target)
    if current >= target then return "^"
    elseif current >= target * 0.8 then return "->"
    else return "v" end
end

-- ============================================================
-- Game State Extraction
-- ============================================================

local function get_date()
    local year = df.global.cur_year
    local tick = df.global.cur_year_tick
    local day = math.floor(tick / 1200) + 1
    local month = math.floor((day - 1) / 28) + 1
    local day_of_month = ((day - 1) % 28) + 1
    
    local seasons = {'Q1', 'Q2', 'Q3', 'Q4'}
    local quarter = seasons[math.floor((month - 1) / 3) + 1]
    
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
        quarter = quarter,
        tick = tick,
        fiscal_year = "FY" .. year
    }
end

-- Find the expedition leader (CEO)
local function get_ceo()
    for _, unit in ipairs(df.global.world.units.active) do
        if dfhack.units.isCitizen(unit) and dfhack.units.isAlive(unit) then
            local profession = df.profession[unit.profession]
            if profession and profession:find("EXPEDITION_LEADER") then
                return {
                    name = translate_name(unit.name, false),
                    id = unit.id
                }
            end
        end
    end
    for _, unit in ipairs(df.global.world.units.active) do
        if dfhack.units.isCitizen(unit) and dfhack.units.isAlive(unit)
           and not dfhack.units.isChild(unit) then
            return {
                name = translate_name(unit.name, false),
                id = unit.id
            }
        end
    end
    return { name = "Unknown Executive", id = -1 }
end

-- Determine business unit for a profession
local function get_business_unit(profession_name)
    for _, bu in ipairs(BUSINESS_UNITS) do
        for _, prof in ipairs(bu.professions) do
            if profession_name:upper():find(prof) then
                return bu.id
            end
        end
    end
    return "operations"
end

local function analyze_population()
    local summary = {
        total_headcount = 0,
        fte = 0,  -- Full-time equivalents (adults)
        dependents = 0,  -- Children
        military = 0,
        on_leave = 0,  -- Injured
        productivity = 0,
        idle = 0,
        engagement = {
            highly_engaged = 0,
            engaged = 0,
            neutral = 0,
            disengaged = 0,
            actively_disengaged = 0
        },
        business_units = {},
        attrition_risk = 0
    }
    
    -- Initialize BU headcounts
    for _, bu in ipairs(BUSINESS_UNITS) do
        summary.business_units[bu.id] = {
            name = bu.name,
            code = bu.code,
            headcount = 0
        }
    end
    
    -- Map stress to engagement (corporate reframing)
    local engagement_map = {
        [0] = "highly_engaged",
        [1] = "highly_engaged",
        [2] = "engaged",
        [3] = "neutral",
        [4] = "disengaged",
        [5] = "actively_disengaged",
        [6] = "actively_disengaged"
    }
    
    for _, unit in ipairs(df.global.world.units.active) do
        if dfhack.units.isCitizen(unit) and dfhack.units.isAlive(unit) then
            summary.total_headcount = summary.total_headcount + 1
            
            local is_child = dfhack.units.isChild(unit) or dfhack.units.isBaby(unit)
            
            if is_child then
                summary.dependents = summary.dependents + 1
            else
                summary.fte = summary.fte + 1
                
                -- Assign to business unit
                local profession = df.profession[unit.profession] or "PEASANT"
                local bu_id = get_business_unit(profession)
                
                if summary.business_units[bu_id] then
                    summary.business_units[bu_id].headcount = 
                        summary.business_units[bu_id].headcount + 1
                end
                
                -- Check productivity
                if unit.job.current_job then
                    summary.productivity = summary.productivity + 1
                else
                    summary.idle = summary.idle + 1
                end
            end
            
            if is_military(unit) then
                summary.military = summary.military + 1
            end
            
            if unit.health and unit.health.flags.needs_healthcare then
                summary.on_leave = summary.on_leave + 1
            end
            
            -- Engagement score
            local stress_cat = dfhack.units.getStressCategory(unit)
            local engagement = engagement_map[stress_cat] or "neutral"
            if summary.engagement[engagement] then
                summary.engagement[engagement] = summary.engagement[engagement] + 1
            end
            
            -- Attrition risk (stressed or miserable dwarves might "leave")
            if stress_cat >= 5 then
                summary.attrition_risk = summary.attrition_risk + 1
            end
        end
    end
    
    -- Calculate engagement score (eNPS style: 0-100)
    local promoters = summary.engagement.highly_engaged + summary.engagement.engaged
    local detractors = summary.engagement.disengaged + summary.engagement.actively_disengaged
    summary.enps = summary.total_headcount > 0 and 
        math.floor(((promoters - detractors) / summary.total_headcount) * 100 + 50) or 50
    
    -- Productivity rate
    summary.productivity_rate = summary.fte > 0 and 
        math.floor((summary.productivity / summary.fte) * 100) or 0
    
    return summary
end

local function get_resources()
    local food_count = 0
    local drink_count = 0

    -- Calculate wealth by summing item values (df.global.plotinfo.wealth.total is often 0)
    local total_wealth = 0
    local created_wealth = 0

    for _, item in ipairs(df.global.world.items.all) do
        -- Only exclude items that truly don't belong to the fortress
        if not item.flags.trader and not item.flags.hostile and not item.flags.removed and
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

            -- Check for all edible item types
            if df.item_foodst:is_instance(item) or
               df.item_plantst:is_instance(item) or
               df.item_meatst:is_instance(item) or
               df.item_fishst:is_instance(item) or
               df.item_fish_rawst:is_instance(item) or
               df.item_cheesest:is_instance(item) or
               df.item_eggst:is_instance(item) or
               df.item_globst:is_instance(item) or
               df.item_plant_growthst:is_instance(item) or
               df.item_leavesst:is_instance(item) then
                food_count = food_count + 1
            elseif df.item_drinkst:is_instance(item) then
                local size = item.stack_size
                if size > 0 then
                    drink_count = drink_count + size
                else
                    drink_count = drink_count + 1
                end
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
        food = { count = food_count, status = status_for_count(food_count) },
        drink = { count = drink_count, status = status_for_count(drink_count) },
        wealth = {
            total = total_wealth,
            created = created_wealth,
            imported = total_wealth - created_wealth,
            gross_margin = created_wealth > 0 and math.floor((created_wealth - (total_wealth - created_wealth)) / created_wealth * 100) or 0
        },
        runway_days = food_count  -- Simplified: 1 food = 1 day of runway
    }
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

local function collect_state()
    return {
        date = get_date(),
        fortress = get_fortress_info(),
        ceo = get_ceo(),
        population = analyze_population(),
        resources = get_resources(),
        military = get_military(),
        buildings = get_buildings_summary(),
        events = get_recent_events()
    }
end

local function collect_state()
    return {
        date = get_date(),
        fortress = get_fortress_info(),
        ceo = get_ceo(),
        population = analyze_population(),
        resources = get_resources(),
        military = get_military(),
        buildings = get_buildings_summary(),
        events = get_recent_events()
    }
end

-- ============================================================
-- Dashboard Generation (Executive Summary Style)
-- ============================================================

local function identify_risks(state)
    local risks = {}
    local pop = state.population
    local res = state.resources
    
    if res.food.status == "critical" then
        table.insert(risks, {
            level = "CRITICAL",
            category = "Operations",
            description = "Food supply chain disruption - immediate intervention required"
        })
    end
    if res.drink.status == "critical" then
        table.insert(risks, {
            level = "CRITICAL", 
            category = "HR",
            description = "Employee wellness at risk - beverage shortage impacting morale"
        })
    end
    if pop.attrition_risk > 0 then
        table.insert(risks, {
            level = "HIGH",
            category = "HR",
            description = plural(pop.attrition_risk, "employee") .. " flagged as attrition risk"
        })
    end
    if pop.idle > 5 then
        table.insert(risks, {
            level = "MEDIUM",
            category = "Operations",
            description = "Resource utilization below target - " .. pop.idle .. " FTEs unassigned"
        })
    end
    if pop.military < (pop.total_headcount / 10) then
        table.insert(risks, {
            level = "MEDIUM",
            category = "Security",
            description = "Security team understaffed relative to headcount"
        })
    end
    
    for _, evt in ipairs(state.events) do
        if evt.type == "SIEGE" and evt.text:find("arrived") then
            table.insert(risks, {
                level = "CRITICAL",
                category = "Security",
                description = "Hostile M&A attempt detected - competitors at perimeter"
            })
            break
        end
    end
    
    return risks
end

local function generate_dashboard(state)
    local date = state.date
    local fort = state.fortress
    local pop = state.population
    local res = state.resources
    local mil = state.military
    local bld = state.buildings
    local ceo = state.ceo
    
    local risks = identify_risks(state)
    
    local lines = {
        "+==============================================================+",
        "|                    EXECUTIVE DASHBOARD                       |",
        string.format("|                    %s %s                            |",
            date.fiscal_year, date.quarter),
        "+==============================================================+",
        "",
        string.format("Company: %s Inc.", fort.name_english),
        string.format("CEO: %s", ceo.name),
        string.format("Report Date: %d %s, Year %d", date.day, date.month_name, date.year),
        "",
        "==============================================================",
        "                       KEY METRICS",
        "==============================================================",
        "",
        "+-----------------+-------------+-------------+--------------+",
        "| METRIC          | ACTUAL      | TARGET      | STATUS       |",
        "+-----------------+-------------+-------------+--------------+",
        string.format("| Total Headcount | %4d        | --          | --           |", pop.total_headcount),
        string.format("| FTE             | %4d        | --          | --           |", pop.fte),
        string.format("| Productivity    | %3d%%        | 85%%         | %s            |", 
            pop.productivity_rate, pop.productivity_rate >= 85 and "OK" or "!"),
        string.format("| eNPS Score      | %3d         | 50          | %s            |",
            pop.enps, pop.enps >= 50 and "OK" or "!"),
        string.format("| Attrition Risk  | %4d        | 0           | %s            |",
            pop.attrition_risk, pop.attrition_risk == 0 and "OK" or "!!"),
        "+-----------------+-------------+-------------+--------------+",
        "",
        "+-----------------+-------------+-------------+--------------+",
        "| FINANCIALS      | ACTUAL      | TARGET      | STATUS       |",
        "+-----------------+-------------+-------------+--------------+",
        string.format("| Total Assets    | %7s$    | --          | --           |", format_number(res.wealth.total)),
        string.format("| Created Value   | %7s$    | --          | --           |", format_number(res.wealth.created)),
        string.format("| Gross Margin    | %3d%%        | 70%%         | %s            |",
            res.wealth.gross_margin, res.wealth.gross_margin >= 70 and "OK" or "!"),
        "+-----------------+-------------+-------------+--------------+",
        "",
        "+-----------------+-------------+-------------+--------------+",
        "| OPERATIONS      | ACTUAL      | TARGET      | STATUS       |",
        "+-----------------+-------------+-------------+--------------+",
        string.format("| Food Inventory  | %4d units  | 200         | %s %s         |",
            res.food.count, status_indicator(res.food.status), res.food.status),
        string.format("| Beverage Inv.   | %4d units  | 200         | %s %s         |",
            res.drink.count, status_indicator(res.drink.status), res.drink.status),
        string.format("| Runway          | %4d days   | 90          | %s            |",
            res.runway_days, res.runway_days >= 90 and "OK" or "!"),
        string.format("| Facilities      | %4d        | --          | --           |", 
            bld.workshops + bld.furnaces),
        "+-----------------+-------------+-------------+--------------+",
        ""
    }
    
    -- Org breakdown
    table.insert(lines, "==============================================================")
    table.insert(lines, "                    HEADCOUNT BY BU")
    table.insert(lines, "==============================================================")
    table.insert(lines, "")
    
    local sorted_bus = {}
    for id, data in pairs(pop.business_units) do
        table.insert(sorted_bus, {id = id, name = data.name, code = data.code, headcount = data.headcount})
    end
    table.sort(sorted_bus, function(a, b) return a.headcount > b.headcount end)
    
    for _, bu in ipairs(sorted_bus) do
        local bar_len = pop.fte > 0 and math.floor((bu.headcount / pop.fte) * 25) or 0
        local bar = string.rep("#", bar_len) .. string.rep("-", 25 - bar_len)
        table.insert(lines, string.format("  [%s] %s %3d FTE  %s", 
            bu.code, bar, bu.headcount, bu.name))
    end
    table.insert(lines, "")
    
    -- Risk register
    if #risks > 0 then
        table.insert(lines, "==============================================================")
        table.insert(lines, "                    RISK REGISTER")
        table.insert(lines, "==============================================================")
        table.insert(lines, "")
        for _, risk in ipairs(risks) do
            local indicator = risk.level == "CRITICAL" and "!!" or 
                             risk.level == "HIGH" and "!" or "~"
            table.insert(lines, string.format("  %s [%s] %s: %s", 
                indicator, risk.level, risk.category, risk.description))
        end
        table.insert(lines, "")
    end
    
    -- Security
    table.insert(lines, "==============================================================")
    table.insert(lines, "                    SECURITY POSTURE")
    table.insert(lines, "==============================================================")
    table.insert(lines, "")
    table.insert(lines, string.format("  Security FTEs: %d (%s of workforce)", 
        pop.military, pct(pop.military, pop.total_headcount)))
    for _, squad in ipairs(mil.squads) do
        table.insert(lines, string.format("    * %s: %d operatives", squad.name, squad.members))
    end
    table.insert(lines, "")
    
    -- Events as "Market Intelligence"
    if #state.events > 0 then
        table.insert(lines, "==============================================================")
        table.insert(lines, "                  MARKET INTELLIGENCE")
        table.insert(lines, "==============================================================")
        table.insert(lines, "")
        for _, evt in ipairs(state.events) do
            local category = "GENERAL"
            if evt.type == "CARAVAN" or evt.type == "DIPLOMAT" then category = "PARTNERSHIP"
            elseif evt.type == "SIEGE" or evt.type == "AMBUSH" then category = "COMPETITIVE"
            elseif evt.type == "MIGRANT" then category = "TALENT"
            elseif evt.type == "MASTERPIECE" or evt.type == "ARTIFACT" then category = "INNOVATION"
            elseif evt.type == "DEATH" then category = "HR" end
            table.insert(lines, string.format("  [%s] %s", category, evt.text))
        end
    end
    
    table.insert(lines, "")
    table.insert(lines, "==============================================================")
    table.insert(lines, "       \"Synergizing Vertical Integration Across the Mountain\"")
    table.insert(lines, "==============================================================")
    
    return table.concat(lines, "\n")
end

-- ============================================================
-- LLM Integration
-- ============================================================

local function build_system_prompt(state)
    local ceo = state.ceo
    local date = state.date
    
    local csuite_lines = {}
    for _, exec in ipairs(C_SUITE) do
        table.insert(csuite_lines, string.format(
            "- **%s** (%s): %s. Favorite buzzwords: %s",
            exec.title, exec.full_title, exec.personality,
            table.concat(exec.buzzwords, ", ")
        ))
    end
    
    local bu_lines = {}
    for _, bu in ipairs(BUSINESS_UNITS) do
        table.insert(bu_lines, string.format("- %s (%s)", bu.name, bu.code))
    end
    
    return string.format([[You are simulating a Quarterly Business Review (QBR) at a modern corporation that happens to be a Dwarf Fortress.

## Company Profile
%s Inc. is a vertically-integrated mountain-based enterprise specializing in resource extraction, manufacturing, and artisanal goods. Despite being staffed entirely by dwarves in a medieval fantasy setting, they operate using cutting-edge Fortune 500 management practices.

CEO: %s

## The C-Suite
%s

## Business Units
%s

## Corporate Culture
- Mission: "Synergizing Vertical Integration Across the Mountain"
- Core Values: Innovation Through Excavation, Sustainable Magma Practices, Dwarf-Centric Design
- The company is definitely NOT a cult, despite mandatory all-hands meetings
- Everything is an "opportunity" - even goblin sieges are "competitive pressure"
- Stressed dwarves are "disengaged employees" who need "performance coaching"
- Deaths are "unplanned attrition events"

## QBR Format
This is a formal quarterly business review. The tone should be:
- Drowning in corporate buzzwords and jargon
- Taking itself extremely seriously while being absurd
- Full of PowerPoint-speak: "let's unpack that", "circle back", "take offline"
- Metrics-obsessed but often measuring the wrong things
- Passive-aggressive when things are going poorly

## Output Format

### [QBR] %s %s Quarterly Business Review

#### Opening Remarks (CEO)
[CEO gives vague inspirational opening full of buzzwords]

#### Executive Readouts
[Each C-suite member gives a brief update in character - 2-3 sentences each, very corporate]

#### Strategic Discussion
[Brief discussion showing corporate dysfunction - people talking past each other, blame-shifting, buzzword battles]

#### %s %s OKRs

**Objective 1: [Corporate-speak title]**
*Strategic Pillar: [Growth/Efficiency/Innovation/Risk Mitigation]*
- KR1: [Measurable but phrased in corporate jargon]
- KR2: [Measurable result]
- KR3: [Measurable result]
Owner: [C-suite title]
Success Criteria: [How we'll know we hit it]
Dependencies: [What could block this]

[Repeat for 3-4 objectives]

#### Action Items & Next Steps
[Bullet list of action items with owners, full of corporate speak]

#### Closing Remarks
[CEO closes with more inspirational nonsense]

### [LIST] Overseer Notes
[Drop the corporate character - give the player actual practical advice]

## Style Notes
- Use corporate jargon heavily but keep it readable
- The humor comes from the contrast between corporate speak and dwarf fortress reality
- "Hostile M&A" = goblin siege, "talent acquisition" = migrants, "unplanned attrition" = deaths
- Make it satirical but not mean-spirited
- OKRs should be actually useful for gameplay despite the silly framing]], 
    state.fortress.name_english,
    ceo.name,
    table.concat(csuite_lines, "\n"),
    table.concat(bu_lines, "\n"),
    date.fiscal_year, date.quarter,
    date.fiscal_year, date.quarter)
end

local function build_user_prompt(state, dashboard)
    local pop = state.population
    local available = pop.fte - pop.military - pop.on_leave
    
    local priorities = {}
    if state.resources.food.status == "critical" or state.resources.food.status == "low" then
        table.insert(priorities, "Supply chain optimization (food)")
    end
    if state.resources.drink.status == "critical" or state.resources.drink.status == "low" then
        table.insert(priorities, "Employee wellness initiative (beverages)")
    end
    if pop.military < (pop.total_headcount / 8) then
        table.insert(priorities, "Security team scaling")
    end
    if pop.idle > 5 then
        table.insert(priorities, "Resource utilization improvement")
    end
    if pop.enps < 50 then
        table.insert(priorities, "Employee engagement program")
    end
    table.insert(priorities, "Revenue growth")
    table.insert(priorities, "Operational excellence")
    
    local prompt = "# Pre-Read Materials for QBR\n\n"
    prompt = prompt .. dashboard .. "\n\n"
    prompt = prompt .. "## Strategic Context\n"
    prompt = prompt .. "Available FTEs for new initiatives: " .. available .. "\n"
    prompt = prompt .. "Employee engagement (eNPS): " .. pop.enps .. "\n"
    prompt = prompt .. "Recommended focus areas: " .. table.concat(priorities, ", ") .. "\n\n"
    prompt = prompt .. "Please conduct the Quarterly Business Review and produce OKRs for the coming quarter."
    
    return prompt
end

local function print_llm_prompt(system_prompt, user_prompt)
    -- Combine system and user prompts for standard chat UIs
    local combined_prompt = system_prompt .. "\n\n" .. user_prompt
    print(combined_prompt)
end

-- ============================================================
-- Commands
-- ============================================================

local function cmd_status()
    local state = collect_state()
    local pop = state.population
    
    print(string.format(
        "=== %s Inc. | %s %s | HC: %d | eNPS: %d | Productivity: %d%% | Runway: %dd ===",
        state.fortress.name_english,
        state.date.fiscal_year, state.date.quarter,
        pop.total_headcount, pop.enps, pop.productivity_rate,
        state.resources.runway_days
    ))
end

local function cmd_dashboard()
    print("")
    local state = collect_state()
    local dashboard = generate_dashboard(state)
    print(dashboard)
    
    local f = io.open(CONFIG.output_dir .. "/dashboard.txt", "w")
    f:write(dashboard)
    f:close()
end

local function cmd_org()
    local state = collect_state()
    local pop = state.population
    
    print("")
    print("+==============================================================+")
    print(string.format("|           %s INC. - ORG CHART                    |",
        state.fortress.name_english:upper():sub(1,15)))
    print("+==============================================================+")
    print("")
    print(string.format("  CEO: %s", state.ceo.name))
    print("  |")
    print(string.format("  +-- Total Headcount: %d", pop.total_headcount))
    print(string.format("  +-- Full-Time Equivalents: %d", pop.fte))
    print(string.format("  +-- Dependents (covered under benefits): %d", pop.dependents))
    print(string.format("  +-- Currently on Leave: %d", pop.on_leave))
    print("")
    print("  Business Units:")
    print("  -------------------------------------------------------------")
    
    local sorted = {}
    for id, data in pairs(pop.business_units) do
        table.insert(sorted, {id = id, name = data.name, code = data.code, headcount = data.headcount})
    end
    table.sort(sorted, function(a, b) return a.headcount > b.headcount end)
    
    for _, bu in ipairs(sorted) do
        local bar_len = pop.fte > 0 and math.floor((bu.headcount / pop.fte) * 30) or 0
        local bar = string.rep("#", bar_len) .. string.rep("-", 30 - bar_len)
        print(string.format("  [%s] %s %3d FTE (%s)", 
            bu.code, bar, bu.headcount, pct(bu.headcount, pop.fte)))
        print(string.format("        %s", bu.name))
    end
    print("")
    print("  Engagement Breakdown:")
    print("  -------------------------------------------------------------")
    print(string.format("  Highly Engaged:      %3d  ########## (promoters)", pop.engagement.highly_engaged))
    print(string.format("  Engaged:             %3d  ########", pop.engagement.engaged))
    print(string.format("  Neutral:             %3d  ###### (passives)", pop.engagement.neutral))
    print(string.format("  Disengaged:          %3d  ####", pop.engagement.disengaged))
    print(string.format("  Actively Disengaged: %3d  ## (detractors)", pop.engagement.actively_disengaged))
    print("")
    print(string.format("  Employee Net Promoter Score (eNPS): %d", pop.enps))
    print("")
end

local function cmd_qbr()
    local state = collect_state()
    
    print("")
    print("+==============================================================+")
    print("|                                                              |")
    print("|                 QUARTERLY BUSINESS REVIEW                    |")
    print("|                                                              |")
    print(string.format("|                    %s %s                             |",
        state.date.fiscal_year, state.date.quarter))
    print(string.format("|                  %s Inc.                       |",
        state.fortress.name_english:sub(1,12) .. string.rep(" ", 12 - math.min(#state.fortress.name_english, 12))))
    print("|                                                              |")
    print("+==============================================================+")
    print("")
    
    local dashboard = generate_dashboard(state)
    local system_prompt = build_system_prompt(state)
    local user_prompt = build_user_prompt(state, dashboard)

    -- Print the prompt for manual copy/paste to LLM
    print_llm_prompt(system_prompt, user_prompt)
end

-- ============================================================
-- Entry Point
-- ============================================================

local args = argparse.processArgsGetopt({...}, {})
local command = args[1] or "help"

if command == "qbr" then
    cmd_qbr()
elseif command == "dashboard" then
    cmd_dashboard()
elseif command == "org" then
    cmd_org()
elseif command == "status" then
    cmd_status()
else
    print("+==============================================================+")
    print("|              DWARVEN CORPORATION - Dwarf Fortress            |")
    print("|      \"Synergizing Vertical Integration Across the Mountain\" |")
    print("+==============================================================+")
    print("")
    print("Commands:")
    print("  dwarven-corp qbr        - Quarterly Business Review (generates OKRs)")
    print("  dwarven-corp dashboard  - Executive dashboard")
    print("  dwarven-corp org        - Organizational chart")
    print("  dwarven-corp status     - Quick status line")
    print("")
    print("Let's circle back and align on our strategic priorities!")
end
