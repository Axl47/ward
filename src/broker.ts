// The broker moved to broker.js. A wardd started before that upgrade still spawns
// this path until it is restarted, so it stays as a forwarder; remove it in a
// later release.
import "./broker.js";
