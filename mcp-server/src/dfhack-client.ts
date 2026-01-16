import * as net from 'net';

// DFHack RPC constants
const DFHACK_MAGIC_REQUEST = 'DFHack?\n';
const DFHACK_MAGIC_REPLY = 'DFHack!\n';
const DFHACK_VERSION = 1;

// RPC message IDs
const RPC_REPLY_RESULT = -1;
const RPC_REPLY_FAIL = -2;
const RPC_REPLY_TEXT = -3;
const RPC_REQUEST_QUIT = -4;

// Built-in method IDs
const METHOD_BIND = 0;
const METHOD_RUN_COMMAND = 1;

// Simple protobuf encoder for CoreRunCommandRequest
// message CoreRunCommandRequest {
//   required string command = 1;
//   repeated string arguments = 2;
// }
function encodeRunCommandRequest(command: string, args: string[] = []): Buffer {
    const parts: Buffer[] = [];

    // Field 1: command (string, wire type 2 = length-delimited)
    const commandBytes = Buffer.from(command, 'utf8');
    parts.push(Buffer.from([0x0a])); // field 1, wire type 2
    parts.push(encodeVarint(commandBytes.length));
    parts.push(commandBytes);

    // Field 2: arguments (repeated string)
    for (const arg of args) {
        const argBytes = Buffer.from(arg, 'utf8');
        parts.push(Buffer.from([0x12])); // field 2, wire type 2
        parts.push(encodeVarint(argBytes.length));
        parts.push(argBytes);
    }

    return Buffer.concat(parts);
}

function encodeVarint(value: number): Buffer {
    const bytes: number[] = [];
    while (value > 0x7f) {
        bytes.push((value & 0x7f) | 0x80);
        value >>>= 7;
    }
    bytes.push(value & 0x7f);
    return Buffer.from(bytes);
}

// Decode CoreTextNotification from protobuf
// message CoreTextNotification {
//   repeated CoreTextFragment fragments = 1;
// }
// message CoreTextFragment {
//   required string text = 1;
//   optional int32 color = 2;
// }
function decodeTextNotification(buffer: Buffer): string {
    const texts: string[] = [];
    let offset = 0;

    while (offset < buffer.length) {
        const tag = buffer[offset++];
        const fieldNum = tag >> 3;
        const wireType = tag & 0x07;

        if (wireType === 2) { // length-delimited
            const { value: length, bytesRead } = decodeVarint(buffer, offset);
            offset += bytesRead;

            if (fieldNum === 1) { // fragments
                // Parse nested CoreTextFragment
                const fragmentEnd = offset + length;
                while (offset < fragmentEnd) {
                    const fragTag = buffer[offset++];
                    const fragFieldNum = fragTag >> 3;
                    const fragWireType = fragTag & 0x07;

                    if (fragWireType === 2) {
                        const { value: fragLen, bytesRead: fragBytesRead } = decodeVarint(buffer, offset);
                        offset += fragBytesRead;

                        if (fragFieldNum === 1) { // text
                            texts.push(buffer.toString('utf8', offset, offset + fragLen));
                        }
                        offset += fragLen;
                    } else if (fragWireType === 0) {
                        // varint (color field)
                        const { bytesRead: varBytesRead } = decodeVarint(buffer, offset);
                        offset += varBytesRead;
                    }
                }
            } else {
                offset += length;
            }
        } else if (wireType === 0) {
            const { bytesRead } = decodeVarint(buffer, offset);
            offset += bytesRead;
        }
    }

    return texts.join('');
}

function decodeVarint(buffer: Buffer, offset: number): { value: number; bytesRead: number } {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;

    while (offset + bytesRead < buffer.length) {
        const byte = buffer[offset + bytesRead];
        bytesRead++;
        value |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }

    return { value, bytesRead };
}

export interface DFHackClientOptions {
    host?: string;
    port?: number;
    timeout?: number;
}

export class DFHackClient {
    private socket: net.Socket | null = null;
    private host: string;
    private port: number;
    private timeout: number;
    private connected: boolean = false;
    private responseBuffer: Buffer = Buffer.alloc(0);

    constructor(options: DFHackClientOptions = {}) {
        this.host = options.host ?? 'localhost';
        this.port = options.port ?? 5000;
        this.timeout = options.timeout ?? 10000;
    }

    async connect(): Promise<void> {
        // Always create a fresh connection
        await this.forceDisconnect();

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.forceDisconnect();
                reject(new Error(`Connection timeout after ${this.timeout}ms`));
            }, this.timeout);

            this.socket = net.createConnection({ host: this.host, port: this.port }, async () => {
                clearTimeout(timeoutId);
                try {
                    await this.handshake();
                    this.connected = true;
                    resolve();
                } catch (err) {
                    this.forceDisconnect();
                    reject(err);
                }
            });

            this.socket.on('error', (err) => {
                clearTimeout(timeoutId);
                this.forceDisconnect();
                reject(err);
            });

            this.socket.on('close', () => {
                this.connected = false;
                this.socket = null;
            });
        });
    }

    private forceDisconnect(): Promise<void> {
        this.connected = false;
        this.responseBuffer = Buffer.alloc(0);
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }
        return Promise.resolve();
    }

    private async handshake(): Promise<void> {
        if (!this.socket) throw new Error('Socket not initialized');

        // Send handshake request
        const request = Buffer.alloc(12);
        request.write(DFHACK_MAGIC_REQUEST, 0, 8, 'ascii');
        request.writeInt32LE(DFHACK_VERSION, 8);
        this.socket.write(request);

        // Wait for handshake response
        const response = await this.readBytes(12);

        const magic = response.toString('ascii', 0, 8);
        const version = response.readInt32LE(8);

        if (magic !== DFHACK_MAGIC_REPLY) {
            throw new Error(`Invalid handshake response: ${magic}`);
        }

        if (version !== DFHACK_VERSION) {
            throw new Error(`Version mismatch: expected ${DFHACK_VERSION}, got ${version}`);
        }
    }

    private readBytes(count: number): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            if (!this.socket) {
                reject(new Error('Socket not connected'));
                return;
            }

            const timeoutId = setTimeout(() => {
                reject(new Error(`Read timeout after ${this.timeout}ms`));
            }, this.timeout);

            const checkBuffer = () => {
                if (this.responseBuffer.length >= count) {
                    clearTimeout(timeoutId);
                    const result = this.responseBuffer.subarray(0, count);
                    this.responseBuffer = this.responseBuffer.subarray(count);
                    resolve(result);
                    return true;
                }
                return false;
            };

            if (checkBuffer()) return;

            const onData = (data: Buffer) => {
                this.responseBuffer = Buffer.concat([this.responseBuffer, data]);
                if (checkBuffer()) {
                    this.socket?.off('data', onData);
                }
            };

            this.socket.on('data', onData);
        });
    }

    async runCommand(command: string, args: string[] = []): Promise<{ success: boolean; output: string; error?: string }> {
        if (!this.connected || !this.socket) {
            throw new Error('Not connected to DFHack');
        }

        // Encode the request
        const payload = encodeRunCommandRequest(command, args);

        // Build message header
        const header = Buffer.alloc(8);
        header.writeInt16LE(METHOD_RUN_COMMAND, 0);
        header.writeInt16LE(0, 2); // padding
        header.writeInt32LE(payload.length, 4);

        // Send request
        this.socket.write(Buffer.concat([header, payload]));

        // Collect all text notifications and the final result
        const textParts: string[] = [];

        while (true) {
            // Read response header
            const respHeader = await this.readBytes(8);
            const respId = respHeader.readInt16LE(0);
            const respSize = respHeader.readInt32LE(4);

            // Read response body if any
            let respBody: Buffer = Buffer.alloc(0);
            if (respSize > 0) {
                respBody = Buffer.from(await this.readBytes(respSize));
            }

            if (respId === RPC_REPLY_TEXT) {
                // Text notification - collect output
                const text = decodeTextNotification(respBody);
                if (text) textParts.push(text);
            } else if (respId === RPC_REPLY_RESULT) {
                // Success - return collected text
                return { success: true, output: textParts.join('') };
            } else if (respId === RPC_REPLY_FAIL) {
                // Failure - return error code
                const errorCode = respHeader.readInt32LE(4);
                return {
                    success: false,
                    output: textParts.join(''),
                    error: `Command failed with code ${errorCode}`
                };
            }
        }
    }

    async disconnect(): Promise<void> {
        if (!this.socket || !this.connected) return;

        // Send quit message
        const quitHeader = Buffer.alloc(8);
        quitHeader.writeInt16LE(RPC_REQUEST_QUIT, 0);
        quitHeader.writeInt16LE(0, 2);
        quitHeader.writeInt32LE(0, 4);
        this.socket.write(quitHeader);

        this.socket.end();
        this.socket = null;
        this.connected = false;
    }

    isConnected(): boolean {
        return this.connected;
    }
}
