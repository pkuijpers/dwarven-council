-- dwarven-common.lua
-- Shared library for Dwarven Governance scripts
-- Place in: <DF>/hack/scripts/dwarven-common.lua

local common = {}

-- ============================================================
-- Utility Functions
-- ============================================================

function common.safe_get(fn, default)
    local ok, result = pcall(fn)
    return ok and result or default
end

function common.plural(n, word, plural_word)
    return n == 1 and (n .. " " .. word) or (n .. " " .. (plural_word or word .. "s"))
end

function common.pct(n, total)
    if total == 0 then return "0%" end
    return math.floor((n / total) * 100) .. "%"
end

function common.status_indicator(status)
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

-- Helper to translate names (supports both old and new DFHack APIs)
function common.translate_name(name_obj, in_english)
    -- Try new API first
    if dfhack.translation and dfhack.translation.translateName then
        return dfhack.translation.translateName(name_obj, in_english)
    end
    -- Fall back to old API
    if dfhack.TranslateName then
        return dfhack.TranslateName(name_obj, in_english)
    end
    -- Last resort: use raw name
    return tostring(name_obj)
end

-- Helper to check if unit is military (squad member)
function common.is_military(unit)
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

-- ============================================================
-- Game State Extraction
-- ============================================================

function common.get_fortress_info()
    local site = df.global.world.world_data.active_site[0]
    if not site then
        return { name = "Unknown", name_english = "Unknown Fortress", founded_year = 0 }
    end
    return {
        name = common.translate_name(site.name, false),
        name_english = common.translate_name(site.name, true),
        founded_year = common.safe_get(function() return site.created_year end, 0)
    }
end

function common.get_resources()
    local food_count = 0
    local drink_count = 0
    local wealth = 0

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

            wealth = wealth + (item:getBaseValue() or 0)
        end
    end

    local function resource_status(count, low_thresh, adequate_thresh)
        if count < low_thresh then return "critical"
        elseif count < adequate_thresh then return "low"
        elseif count < adequate_thresh * 2 then return "adequate"
        else return "abundant"
        end
    end

    return {
        food = { count = food_count, status = resource_status(food_count, 100, 500) },
        drink = { count = drink_count, status = resource_status(drink_count, 100, 500) },
        wealth = wealth
    }
end

function common.get_military()
    local squads = {}
    local total_members = 0

    for _, squad in ipairs(df.global.world.squads.all) do
        local member_count = 0
        if squad.positions then
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
                total_members = total_members + member_count
            end
        end
    end

    return {
        squad_count = #squads,
        total_soldiers = total_members,
        squads = squads
    }
end

function common.get_recent_events()
    local events = {}
    local announcements = df.global.world.status.announcements

    if not announcements then return events end

    local start_idx = math.max(0, #announcements - 20)
    for i = start_idx, #announcements - 1 do
        local ann = announcements[i]
        if ann then
            table.insert(events, {
                type = df.announcement_type[ann.type],
                text = ann.text or ""
            })
        end
    end

    return events
end

function common.get_buildings_summary()
    local counts = {
        workshops = 0,
        furnaces = 0,
        beds = 0,
        tables = 0,
        chairs = 0
    }

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

function common.get_mining_inventory()
    -- Cache for inorganic material lookups
    local matinfo_cache = {}

    local function get_matinfo(mat_type, mat_index)
        local key = mat_type .. "_" .. mat_index
        if not matinfo_cache[key] then
            matinfo_cache[key] = dfhack.matinfo.decode(mat_type, mat_index)
        end
        return matinfo_cache[key]
    end

    local function get_material_name(matinfo)
        if not matinfo then return "unknown" end
        return matinfo.material and matinfo.material.id or matinfo:toString() or "unknown"
    end

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
                local mat_name = get_material_name(matinfo)

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

    -- Vein analysis tables
    local ore_veins = {}       -- key = ore name, value = tile count
    local gem_deposits = {}    -- key = gem name, value = tile count

    -- Scan map for mineral veins
    local x_blocks, y_blocks, z_blocks = dfhack.maps.getSize()

    for z = 0, z_blocks - 1 do
        for y = 0, y_blocks - 1 do
            for x = 0, x_blocks - 1 do
                local block = dfhack.maps.getBlock(x, y, z)

                if block and block.block_events then
                    -- Process mineral veins in this block
                    for _, event in ipairs(block.block_events) do
                        if df.block_square_event_mineralst:is_instance(event) then
                            local mat_index = event.inorganic_mat

                            -- Get material info
                            local inorganic = df.global.world.raws.inorganics[mat_index]
                            if inorganic then
                                local mat_id = inorganic.id
                                local is_ore = inorganic.flags.METAL_ORE
                                local is_gem = inorganic.flags.IS_GEM

                                -- Count tiles in this vein
                                local tile_count = 0
                                for tile_x = 0, 15 do
                                    for tile_y = 0, 15 do
                                        -- Check if tile has this mineral and is revealed
                                        if event.tile_bitmask:get(tile_x, tile_y) then
                                            local designation = block.designation[tile_x][tile_y]
                                            if not designation.hidden then
                                                tile_count = tile_count + 1
                                            end
                                        end
                                    end
                                end

                                -- Add to appropriate category
                                if tile_count > 0 then
                                    if is_gem then
                                        gem_deposits[mat_id] = (gem_deposits[mat_id] or 0) + tile_count
                                    elseif is_ore then
                                        ore_veins[mat_id] = (ore_veins[mat_id] or 0) + tile_count
                                    end
                                end
                            end
                        end
                    end
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

function common.format_mining_report(mining_data)
    if not mining_data then return "" end

    local lines = {}

    -- Helper to format material counts
    local function format_counts(tbl, max_items)
        if not tbl then return "none" end
        local items = {}
        local count = 0
        for mat, num in pairs(tbl) do
            if count >= (max_items or 10) then
                items[#items + 1] = "..."
                break
            end
            items[#items + 1] = num .. " " .. mat:lower()
            count = count + 1
        end
        if #items == 0 then return "none" end
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

    -- Ore veins
    local ore_items = {}
    if mining_data.ore_veins then
        for ore, tiles in pairs(mining_data.ore_veins) do
            ore_items[#ore_items + 1] = "~" .. tiles .. " tiles " .. ore:lower()
        end
    end
    if #ore_items > 0 then
        lines[#lines + 1] = "**Ore Veins:** " .. table.concat(ore_items, ", ")
    else
        lines[#lines + 1] = "**Ore Veins:** none detected"
    end

    -- Gem deposits
    local gem_items = {}
    if mining_data.gem_deposits then
        for gem, tiles in pairs(mining_data.gem_deposits) do
            gem_items[#gem_items + 1] = "~" .. tiles .. " tiles " .. gem:lower()
        end
    end
    if #gem_items > 0 then
        lines[#lines + 1] = "**Gem Deposits:** " .. table.concat(gem_items, ", ")
    else
        lines[#lines + 1] = "**Gem Deposits:** none detected"
    end

    return table.concat(lines, "\n")
end

-- ============================================================
-- LLM Integration
-- ============================================================

function common.call_llm(config, system_prompt, user_prompt, context_label)
    local json = require('json')
    local http = require('socket.http')
    local ltn12 = require('ltn12')

    local request = {
        model = config.model,
        max_tokens = 2500,
        system = system_prompt,
        messages = {{ role = "user", content = user_prompt }}
    }

    local request_file = config.output_dir .. "/request.json"
    local response_file = config.output_dir .. "/response.json"

    local request_body = json.encode(request)

    -- Save request for debugging
    local f = io.open(request_file, "w")
    f:write(request_body)
    f:close()

    print("[" .. context_label .. "] Consulting the oracle...")

    -- Use luasocket to make HTTP request (DFHack blocks io.popen and os.execute)
    local response_body = {}
    local res, code, response_headers, status = http.request{
        url = config.api_url,
        method = "POST",
        headers = {
            ["Content-Type"] = "application/json",
            ["x-api-key"] = config.api_key,
            ["anthropic-version"] = "2023-06-01",
            ["Content-Length"] = tostring(#request_body)
        },
        source = ltn12.source.string(request_body),
        sink = ltn12.sink.table(response_body)
    }

    if not res then
        print("[" .. context_label .. "] ERROR: HTTP request failed: " .. tostring(code))
        return nil
    end

    if code ~= 200 then
        print("[" .. context_label .. "] ERROR: API returned status code " .. tostring(code))
        print("[" .. context_label .. "] Response: " .. table.concat(response_body))
        return nil
    end

    local response_text = table.concat(response_body)

    -- Save response for debugging
    local rf = io.open(response_file, "w")
    if rf then
        rf:write(response_text)
        rf:close()
    end

    local ok, response = pcall(json.decode, response_text)
    if not ok or response.error then
        print("[" .. context_label .. "] API Error: " .. (response.error and response.error.message or "Unknown error"))
        print("[" .. context_label .. "] Raw response saved to: " .. response_file)
        return nil
    end

    if response.content and response.content[1] then
        return response.content[1].text
    end
    return nil
end

return common
