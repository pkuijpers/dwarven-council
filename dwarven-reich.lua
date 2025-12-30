-- dwarven-reich.lua
-- The Stonefather Reich - Authoritarian Dwarf Fortress addon
-- Place in: <DF>/hack/scripts/
--
-- Usage:
--   dwarven-reich decree    - The Stonefather issues the quarterly Granite Decrees
--   dwarven-reich report    - Status report for the Stonefather
--   dwarven-reich status    - Brief status
--
-- "One People. One Mountain. One Stonefather."

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
    output_dir = "/tmp/dwarven-reich",
}

-- Create output directory using DFHack filesystem API
dfhack.filesystem.mkdir_recursive(CONFIG.output_dir)

-- ============================================================
-- The Stonefather's Hierarchy
-- ============================================================

-- The Stonefather is advised by his Council of Iron
-- They advise, but only the Stonefather decides
local COUNCIL_OF_IRON = {
    {
        title = "Grand Smith",
        role = "Production Advisor",
        sphere = "workshops, production, craftsmanship",
        personality = "Demands perfection and efficiency. Despises laziness."
    },
    {
        title = "Supreme Minelord", 
        role = "Expansion Advisor",
        sphere = "mining, expansion, resources",
        personality = "Hungry for depth. The mountain must be opened."
    },
    {
        title = "War Marshal",
        role = "Defense Advisor", 
        sphere = "militia, defense, enemies",
        personality = "Paranoid and militant. Sees threats everywhere."
    },
    {
        title = "Provisions Intendant",
        role = "Supplies Advisor",
        sphere = "food, drink, agriculture",
        personality = "Bureaucratic. Counts every grain and drop."
    },
    {
        title = "Propaganda Master",
        role = "Morale Advisor",
        sphere = "morale, loyalty, discipline",
        personality = "Fanatically loyal. Sees dissidence everywhere."
    }
}

-- Ranks within the Reich (for citizens)
local RANKS = {
    { name = "Reichsdwarf", min_skill = 0 },
    { name = "Labor Dwarf First Class", min_skill = 5 },
    { name = "Master Dwarf", min_skill = 10 },
    { name = "Hero Dwarf", min_skill = 15 },
    { name = "Reich Hero", min_skill = 20 }
}

-- ============================================================
-- Game State Extraction (Reich-specific)
-- ============================================================

local function get_date()
    local year = df.global.cur_year
    local tick = df.global.cur_year_tick
    local day = math.floor(tick / 1200) + 1
    local month = math.floor((day - 1) / 28) + 1
    local day_of_month = ((day - 1) % 28) + 1
    
    local seasons = {'Spring', 'Summer', 'Autumn', 'Winter'}
    local season = seasons[math.floor((month - 1) / 3) + 1]
    
    -- Official Reich Calendar
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
        tick = tick,
        -- Reich year counts from founding
        reich_year = year - safe_get(function() 
            return df.global.world.world_data.active_site[0].created_year 
        end, year) + 1
    }
end

-- Find the expedition leader (the Stonefather)
local function get_stonefather()
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
    -- Fallback: first adult dwarf
    for _, unit in ipairs(df.global.world.units.active) do
        if dfhack.units.isCitizen(unit) and dfhack.units.isAlive(unit)
           and not dfhack.units.isChild(unit) then
            return {
                name = translate_name(unit.name, false),
                id = unit.id
            }
        end
    end
    return { name = "Unknown Leader", id = -1 }
end

local function analyze_population()
    local summary = {
        total = 0,
        adults = 0,
        children = 0,
        military = 0,
        injured = 0,
        productive = 0,  -- Working citizens
        idle = 0,        -- Potential dissidents
        stress = {
            joyous = 0, happy = 0, content = 0, fine = 0,
            unhappy = 0, stressed = 0, miserable = 0
        },
        loyalty = "UNKNOWN"
    }
    
    local stress_categories = {
        [0] = "joyous", [1] = "happy", [2] = "content", [3] = "fine",
        [4] = "unhappy", [5] = "stressed", [6] = "miserable"
    }
    
    for _, unit in ipairs(df.global.world.units.active) do
        if dfhack.units.isCitizen(unit) and dfhack.units.isAlive(unit) then
            summary.total = summary.total + 1
            
            if dfhack.units.isChild(unit) or dfhack.units.isBaby(unit) then
                summary.children = summary.children + 1
            else
                summary.adults = summary.adults + 1
                
                -- Check productivity
                if unit.job.current_job then
                    summary.productive = summary.productive + 1
                else
                    summary.idle = summary.idle + 1
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
    
    -- Calculate loyalty index
    local positive = summary.stress.joyous + summary.stress.happy + summary.stress.content
    local negative = summary.stress.unhappy + summary.stress.stressed + summary.stress.miserable
    local loyalty_pct = summary.total > 0 and math.floor((positive / summary.total) * 100) or 0
    
    if loyalty_pct >= 80 then summary.loyalty = "FANATICAL"
    elseif loyalty_pct >= 60 then summary.loyalty = "LOYAL"
    elseif loyalty_pct >= 40 then summary.loyalty = "ACCEPTABLE"
    elseif loyalty_pct >= 20 then summary.loyalty = "QUESTIONABLE"
    else summary.loyalty = "DISSIDENT" end
    
    summary.loyalty_pct = loyalty_pct
    
    return summary
end

local function get_resources()
    local food_count = 0
    local drink_count = 0

    for _, item in ipairs(df.global.world.items.all) do
        -- Only exclude items that truly don't belong to the fortress
        if not item.flags.trader and not item.flags.hostile and not item.flags.removed then
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
            total = safe_get(function() return df.global.plotinfo.wealth.total end, 0),
            created = safe_get(function() return df.global.plotinfo.wealth.created end, 0),
            imported = safe_get(function() return df.global.plotinfo.wealth.imported end, 0)
        }
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

local function get_buildings_summary()
    local counts = { workshops = 0, furnaces = 0, beds = 0, tables = 0, chairs = 0 }
    
    for _, bld in ipairs(df.global.world.buildings.all) do
        local btype = bld:getType()
        if btype == df.building_type.Workshop then counts.workshops = counts.workshops + 1
        elseif btype == df.building_type.Furnace then counts.furnaces = counts.furnaces + 1
        elseif btype == df.building_type.Bed then counts.beds = counts.beds + 1
        elseif btype == df.building_type.Table then counts.tables = counts.tables + 1
        elseif btype == df.building_type.Chair then counts.chairs = counts.chairs + 1
        end
    end
    
    return counts
end

local function collect_state()
    return {
        date = get_date(),
        fortress = get_fortress_info(),
        stonefather = get_stonefather(),
        population = analyze_population(),
        resources = get_resources(),
        military = get_military(),
        buildings = get_buildings_summary(),
        events = get_recent_events()
    }
end

-- ============================================================
-- Report Generation (Propaganda Style)
-- ============================================================

local function identify_threats(state)
    local threats = {}
    local pop = state.population
    local res = state.resources
    
    if res.food.status == "critical" then
        table.insert(threats, "!! FOOD CRISIS: Enemy sabotage suspected. Immediate action required.")
    end
    if res.drink.status == "critical" then
        table.insert(threats, "!! ALCOHOL SHORTAGE: Morale of the People at risk.")
    end
    if pop.stress.miserable > 0 then
        table.insert(threats, "! DISSIDENCE DETECTED: " .. pop.stress.miserable .. 
                     " element(s) require re-education.")
    end
    if pop.idle > 5 then
        table.insert(threats, "! IDLENESS: " .. pop.idle .. 
                     " non-productive elements. Increase labor deployment.")
    end
    if pop.military < (pop.total / 10) then
        table.insert(threats, "! DEFENSE SHORTAGE: Militia below minimum strength.")
    end
    
    for _, evt in ipairs(state.events) do
        if evt.type == "SIEGE" and evt.text:find("arrived") then
            table.insert(threats, "!! INVASION: Enemy troops at the gates!")
            break
        end
    end
    
    return threats
end

local function generate_report(state)
    local date = state.date
    local fort = state.fortress
    local pop = state.population
    local res = state.resources
    local mil = state.military
    local bld = state.buildings
    local sf = state.stonefather
    
    local threats = identify_threats(state)
    local positive = pop.stress.joyous + pop.stress.happy + pop.stress.content
    local negative = pop.stress.unhappy + pop.stress.stressed + pop.stress.miserable
    
    local lines = {
        "+==============================================================+",
        "|           SECRET REPORT TO THE STONEFATHER                   |",
        "|              For Your Eyes Only                              |",
        "+==============================================================+",
        "",
        string.format("Reich: %s", fort.name_english),
        string.format("Date: %d %s, Year %d (Reich Year %d)", 
            date.day, date.month_name, date.year, date.reich_year),
        string.format("Season: %s", date.season),
        "",
        "==============================================================",
        "                    POPULATION STATISTICS",
        "==============================================================",
        "",
        string.format("Total subjects:        %d souls", pop.total),
        string.format("  Adults:              %d (labor potential)", pop.adults),
        string.format("  Youth:               %d (future workers)", pop.children),
        string.format("  Militia:             %d (defenders of the Reich)", pop.military),
        string.format("  Wounded:             %d", pop.injured),
        "",
        string.format("Productive elements:   %d (%s)", pop.productive, pct(pop.productive, pop.adults)),
        string.format("Idle elements:         %d (%s) %s", pop.idle, pct(pop.idle, pop.adults),
            pop.idle > 5 and "!" or ""),
        "",
        "-- Loyalty Index ---------------------------------------------",
        string.format("Status: [%s] %d%%", pop.loyalty, pop.loyalty_pct),
        string.format("  Fanatically loyal:   %d", pop.stress.joyous),
        string.format("  Loyal:               %d", pop.stress.happy + pop.stress.content),
        string.format("  Neutral:             %d", pop.stress.fine),
        string.format("  Questionable:        %d %s", pop.stress.unhappy, 
            pop.stress.unhappy > 0 and "< observation recommended" or ""),
        string.format("  Potential dissident: %d %s", pop.stress.stressed + pop.stress.miserable,
            (pop.stress.stressed + pop.stress.miserable) > 0 and "< ACTION REQUIRED" or ""),
        ""
    }
    
    -- Threats
    if #threats > 0 then
        table.insert(lines, "==============================================================")
        table.insert(lines, "                    THREAT ANALYSIS")
        table.insert(lines, "==============================================================")
        table.insert(lines, "")
        for _, t in ipairs(threats) do
            table.insert(lines, t)
        end
        table.insert(lines, "")
    end
    
    -- Resources
    table.insert(lines, "==============================================================")
    table.insert(lines, "                    REICH RESOURCES")
    table.insert(lines, "==============================================================")
    table.insert(lines, "")
    table.insert(lines, string.format("Food reserve:    %s %s (%d units)",
        status_indicator(res.food.status), res.food.status:upper(), res.food.count))
    table.insert(lines, string.format("Alcohol reserve: %s %s (%d units)",
        status_indicator(res.drink.status), res.drink.status:upper(), res.drink.count))
    table.insert(lines, string.format("Reich treasury:  %d coins", res.wealth.total))
    table.insert(lines, "")
    
    -- Military
    table.insert(lines, "==============================================================")
    table.insert(lines, "                    MILITARY STRENGTH")
    table.insert(lines, "==============================================================")
    table.insert(lines, "")
    table.insert(lines, string.format("Total militia: %d warriors (%s of population)",
        pop.military, pct(pop.military, pop.total)))
    for _, squad in ipairs(mil.squads) do
        table.insert(lines, string.format("  - %s: %d fighters", squad.name, squad.members))
    end
    table.insert(lines, "")
    
    -- Infrastructure  
    table.insert(lines, "==============================================================")
    table.insert(lines, "                    PRODUCTION CAPACITY")
    table.insert(lines, "==============================================================")
    table.insert(lines, "")
    table.insert(lines, string.format("Workshops:       %d operational", bld.workshops))
    table.insert(lines, string.format("Smelters:        %d operational", bld.furnaces))
    table.insert(lines, string.format("Housing:         %d beds, %d dining spots", bld.beds, bld.tables))
    table.insert(lines, "")
    
    -- Events
    if #state.events > 0 then
        table.insert(lines, "==============================================================")
        table.insert(lines, "                    INTELLIGENCE REPORT")
        table.insert(lines, "==============================================================")
        table.insert(lines, "")
        for _, evt in ipairs(state.events) do
            table.insert(lines, string.format("  [%s] %s", evt.type, evt.text))
        end
    end
    
    table.insert(lines, "")
    table.insert(lines, "==============================================================")
    table.insert(lines, "          One People. One Mountain. One Stonefather.")
    table.insert(lines, string.format("              Glory to %s!", sf.name))
    table.insert(lines, "==============================================================")
    
    return table.concat(lines, "\n")
end

-- ============================================================
-- LLM Integration
-- ============================================================

local function build_system_prompt(state)
    local sf = state.stonefather
    local date = state.date
    
    local council_lines = {}
    for _, member in ipairs(COUNCIL_OF_IRON) do
        table.insert(council_lines, string.format("- **%s** (%s): %s", 
            member.title, member.role, member.personality))
    end
    
    return string.format([[You are simulating the issuance of a GRANITE DECREE by the Stonefather of a Dwarven Reich in Dwarf Fortress.

## The Regime
The dwarves live under the absolute authority of the Stonefather, %s. His word is law, carved in granite.

Core principles of the Reich:
- **Absolute obedience** to the Stonefather
- **Labor ennobles** - idleness is treason
- **Collective strength** - the individual serves the Reich
- **Eternal vigilance** - enemies are everywhere

## The Council of Iron
The Stonefather is advised by his loyal council:
%s

They may advise, but ONLY the Stonefather decides.

## Granite Decree Procedure
1. The Stonefather enters (ceremonial)
2. Report from the Council of Iron (brief, subservient)
3. The Stonefather speaks (dramatic, authoritarian)
4. Issuance of the Granite Decrees (OKRs as absolute decrees)
5. Closing with oath of loyalty

## Output Format

### [ENTRANCE] Entrance of the Stonefather
[Brief ceremonial description]

### [REPORT] Report from the Council of Iron
[Each council member reports BRIEFLY and SUBSERVIENTLY - max 2 sentences each]

### [SPEECH] The Stonefather Speaks
[Dramatic speech from the Stonefather - authoritarian but "fatherly"]

### [DECREE] GRANITE DECREE %d-%s

**By decree of the Stonefather, carved in unbreakable granite:**

#### Decree I: [Title]
*"[Dramatic quote from the Stonefather]"*
- Demand 1: [Measurable demand]
- Demand 2: [Measurable demand]
- Demand 3: [Measurable demand]
Responsible: [Council member]
Penalty for failure: [Threatening consequence]

[Repeat for 3-4 decrees]

### !! Oath of Loyalty
[Brief collective oath, ending with motto]

### [LIST] Notes for the Overseer
[Practical advice for the player, outside the roleplay]

## Style Guidelines
- Tone is AUTHORITARIAN but with dark humor
- The Stonefather is dramatic and grandiose but also absurd
- Council members are groveling and subservient
- Decrees are like OKRs but formulated as absolute commands
- "Penalties for failure" are exaggerated but fitting (mine labor, promotion to front line, etc.)
- Keep it entertaining - this is satire, not glorification]], 
    sf.name, 
    table.concat(council_lines, "\n"),
    date.reich_year,
    date.season)
end

local function build_user_prompt(state, report)
    local pop = state.population
    local available = pop.adults - pop.military - pop.injured
    
    local priorities = {}
    if state.resources.food.status == "critical" or state.resources.food.status == "low" then
        table.insert(priorities, "Increase food production")
    end
    if state.resources.drink.status == "critical" or state.resources.drink.status == "low" then
        table.insert(priorities, "Increase alcohol production")
    end
    if pop.military < (pop.total / 8) then
        table.insert(priorities, "Military expansion")
    end
    if pop.idle > 5 then
        table.insert(priorities, "Eradicate idleness")
    end
    if pop.loyalty_pct < 60 then
        table.insert(priorities, "Restore loyalty")
    end
    table.insert(priorities, "Increase glory of the Reich")
    
    local prompt = "# Secret Report for the Granite Decree Ceremony\n\n"
    prompt = prompt .. report .. "\n\n"
    prompt = prompt .. "## Situation Analysis\n"
    prompt = prompt .. "Available labor force: " .. available .. " subjects\n"
    prompt = prompt .. "Loyalty index: " .. pop.loyalty .. " (" .. pop.loyalty_pct .. "%)\n"
    prompt = prompt .. "Recommended priorities: " .. table.concat(priorities, ", ") .. "\n\n"
    prompt = prompt .. "Conduct the Granite Decree ceremony and issue the decrees for the coming quarter."
    
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
        "=== Reich %s | Year %d-%s | Subjects: %d | Loyalty: %s | Food: %s | Drink: %s ===",
        state.fortress.name_english, state.date.year, state.date.season,
        pop.total, pop.loyalty,
        state.resources.food.status, state.resources.drink.status
    ))
end

local function cmd_report()
    print("")
    local state = collect_state()
    local report = generate_report(state)
    print(report)
    
    local f = io.open(CONFIG.output_dir .. "/report.txt", "w")
    f:write(report)
    f:close()
end

local function cmd_decree()
    local state = collect_state()
    local sf = state.stonefather
    
    print("")
    print("+==============================================================+")
    print("|                                                              |")
    print("|                      GRANITE DECREE                          |")
    print("|                                                              |")
    print(string.format("|           Stonefather %s speaks              |",
        sf.name:sub(1,20) .. string.rep(" ", 20 - math.min(#sf.name, 20))))
    print("|                                                              |")
    print("+==============================================================+")
    print("")
    
    local report = generate_report(state)
    local system_prompt = build_system_prompt(state)
    local user_prompt = build_user_prompt(state, report)

    -- Print the prompt for manual copy/paste to LLM
    print_llm_prompt(system_prompt, user_prompt)
end

-- ============================================================
-- Entry Point  
-- ============================================================

local args = argparse.processArgsGetopt({...}, {})
local command = args[1] or "help"

if command == "decree" then
    cmd_decree()
elseif command == "report" then
    cmd_report()
elseif command == "status" then
    cmd_status()
else
    print("+==============================================================+")
    print("|            THE STONEFATHER REICH - Dwarf Fortress            |")
    print("|          \"One People. One Mountain. One Stonefather.\"        |")
    print("+==============================================================+")
    print("")
    print("Commands:")
    print("  dwarven-reich decree    - The Stonefather issues decrees")
    print("  dwarven-reich report    - Secret status report")
    print("  dwarven-reich status    - Brief status line")
    print("")
    print("All glory to the Stonefather!")
end
