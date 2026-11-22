// Route of the composition root (runtime/cli/main.ts) to the monitor protocol: the entrypoint may
// import only the cli layer of a module (ADR-0006 D1).
export { MONITOR_PROTOCOL_VERSION } from "../domain/protocol.ts";
