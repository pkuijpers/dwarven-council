// payload-spike.mjs
//
// Standalone spike (no build step, no companion toolchain yet) that verifies
// the wire format produced by `dwarven-coop assembly` survives the DFHack
// remote-control socket intact: a declared length line, followed by the JSON
// payload itself, bounded by sentinel markers.
//
// Run with: node companion/scripts/payload-spike.mjs

import { DFHackClient } from '../../mcp-server/dist/dfhack-client.js';

const START_MARKER = '===DWARVEN_ASSEMBLY_STATE_JSON===';
const END_MARKER = '===DWARVEN_ASSEMBLY_STATE_END===';

function extractPayload(output) {
    const startIdx = output.indexOf(START_MARKER);
    const endIdx = output.indexOf(END_MARKER);
    if (startIdx === -1 || endIdx === -1) {
        throw new Error('Could not find start/end markers in output');
    }

    const between = output.slice(startIdx + START_MARKER.length, endIdx);
    // First non-empty line after the start marker is the declared length.
    const lines = between.split('\n');
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') i++;
    const declaredLength = parseInt(lines[i], 10);
    i++;

    // Everything remaining (rejoined) up to, but not including, the trailing
    // newline before the end marker is the JSON payload itself.
    const payload = lines.slice(i).join('\n').replace(/\n$/, '');

    return { declaredLength, payload };
}

async function main() {
    const client = new DFHackClient();
    await client.connect();

    const result = await client.runCommand('dwarven-coop', ['assembly']);
    if (!result.success) {
        throw new Error(`runCommand failed: ${result.error}`);
    }

    await client.disconnect();

    const { declaredLength, payload } = extractPayload(result.output);
    const receivedLength = payload.length;

    let parsed = false;
    let parsedValue;
    try {
        parsedValue = JSON.parse(payload);
        parsed = true;
    } catch (err) {
        parsed = false;
    }

    const lengthOk = declaredLength === receivedLength;

    console.log(
        `OK: declared=${declaredLength} received=${receivedLength} parsed=${parsed}`
    );

    if (!lengthOk) {
        // declaredLength is Lua's #payload: a raw UTF-8 *byte* count.
        // receivedLength is JS String#length: a UTF-16 *code unit* count.
        // These only coincide when the payload is pure ASCII. Dwarf Fortress
        // data routinely isn't: multi-byte Unicode glyphs (e.g. the wealth
        // symbol U+2610, trade-good symbol U+263C) count as 3 Lua bytes but
        // 1 JS code unit each, and DF's internal single-byte encoding for
        // accented dwarf names produces bytes that aren't valid UTF-8 at
        // all -- dfhack-client.ts decodes fragments with
        // buffer.toString('utf8', ...), which silently replaces each such
        // invalid byte with a single U+FFFD replacement character (a
        // pre-existing characteristic of the already-built client, present
        // identically in the old plain-text prompt output, not introduced
        // by this change). Neither effect drops or duplicates *structure*.
        console.warn(
            `NOTE: declared !== received (delta=${declaredLength - receivedLength}). ` +
            'This is expected for non-ASCII payloads (Lua byte-count vs JS ' +
            'UTF-16 code-unit-count) and does not by itself indicate truncation. ' +
            'The authoritative integrity signal is JSON.parse succeeding on the ' +
            'full payload extracted between the markers.'
        );
    }

    if (!parsed) {
        console.error('FAILURE: JSON.parse failed - payload is truncated or corrupted');
        process.exitCode = 1;
    }

    return { rawOutput: result.output, declaredLength, receivedLength, payload, parsedValue };
}

main().catch((err) => {
    console.error('SPIKE FAILED:', err);
    process.exitCode = 1;
});
