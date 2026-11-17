import { Server } from "node:net";

// Guard for the test suite: no server may listen on a random port on every address.
//
// That is what supertest does when handed an app that is not running (`request(app)`): it listens on port 0 on "::"
// and connects to 127.0.0.1. On macOS a port that another program holds on 127.0.0.1 alone (VS Code, desktop app
// helpers) can still be bound on "::", and the request then reaches that other program: a stray 404 or 400 with an
// empty body, or a hang until the test times out. With thousands of requests per run, a few random tests failed on
// every full run.
//
// Use api() or serve(app) from tests/helpers.ts instead; they listen on 127.0.0.1, where the operating system refuses
// a port that is already taken. Only a random-port listen without a host is refused; nothing else is changed.
const listen = Server.prototype.listen;

Server.prototype.listen = function guardedListen(this: Server, ...args: unknown[]) {
  if (args[0] === 0 && typeof args[1] !== "string") {
    throw new Error("A test server must listen on 127.0.0.1: use api() or serve(app) from tests/helpers.ts instead of request(app).");
  }

  return (listen as (...values: unknown[]) => Server).apply(this, args);
} as typeof listen;
