// Test fixture: loads the API's real configuration (src/config/env.ts) the way the server does at start, and prints
// which store it chose and the endpoint and region it will use. Run only by tests/object-storage.test.ts with invented values.
import { env } from "../../src/config/env";

const config = env.fileStorage;
console.log(JSON.stringify(config && config.driver !== "local" ? { driver: config.driver, endpoint: config.endpoint, region: config.region, bucket: config.bucket } : config));
