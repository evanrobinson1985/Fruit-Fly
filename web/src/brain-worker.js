import { createBrainServer } from "./brain-server.js";

const handle = createBrainServer((msg, transfer) => self.postMessage(msg, transfer || []));
self.onmessage = (e) => handle(e.data);
