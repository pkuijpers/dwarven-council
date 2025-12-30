#!/bin/bash
# Install Dwarven Governance scripts to DFHack

# DFHack directories for Steam flatpak installation
DF_BASE="/home/pieter/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Dwarf Fortress"
DFHACK_SCRIPTS="$DF_BASE/hack/scripts"
DFHACK_LUA="$DF_BASE/hack/lua"

# Check if DFHack directories exist
if [ ! -d "$DFHACK_SCRIPTS" ]; then
    echo "Error: DFHack scripts directory not found at:"
    echo "$DFHACK_SCRIPTS"
    echo ""
    echo "Make sure Dwarf Fortress with DFHack is installed via Steam."
    exit 1
fi

# Copy all scripts to scripts directory
echo "Installing Dwarven Governance scripts..."
cp -v dwarven-coop.lua "$DFHACK_SCRIPTS/"
cp -v dwarven-reich.lua "$DFHACK_SCRIPTS/"
cp -v dwarven-corp.lua "$DFHACK_SCRIPTS/"

echo ""
echo "Installation complete!"
echo ""
echo "You can now use these commands in the DFHack console:"
echo "  dwarven-coop assembly"
echo "  dwarven-reich decree"
echo "  dwarven-corp qbr"
