// Server smoke test: BASE=http://127.0.0.1:8080 node test/api.mjs
// Creates rooms, changes the BPM, checks presence, the error responses, the static files and the link previews.
import assert from "node:assert/strict";

const BASE = process.env.BASE ?? "http://127.0.0.1:8080";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function call(path, method = "GET", body) {
  const res = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text) } catch {}
  return { status: res.status, text, json, type: res.headers.get("content-type") ?? "", headers: res.headers };
}

// /time: Unix ms with a fraction
const time = await call("/time");
assert.equal(time.status, 200);
assert.ok(Math.abs(+time.text - Date.now()) < 5000, `/time is off: ${time.text}`);

// create a room
const t1 = Date.now();
const created = await call("/api/rooms", "POST", { owner: "  Ana  " });
assert.equal(created.status, 201);
const room = created.json;
assert.match(room.id, UUID);
assert.equal(room.owner, "Ana"); // trimmed
assert.equal(room.name, undefined); // rooms have no name
assert.equal(room.bpm, 120);
assert.ok(Number.isInteger(room.t0) && Math.abs(room.t0 - t1) < 5000);
assert.deepEqual(room.members, ["Ana"]);

// name cleanup
assert.equal((await call("/api/rooms", "POST", { owner: "a\u0000<b>" })).json.owner, "a<b>"); // the front end shows it as text
assert.equal((await call("/api/rooms", "POST", { owner: "x".repeat(100) })).json.owner.length, 40);
assert.equal((await call("/api/rooms", "POST", {})).json.owner, "guest");
assert.equal((await call("/api/rooms", "POST", "{not json")).status, 400);
assert.equal((await call("/api/rooms", "POST", "[1,2]")).status, 400);
assert.equal((await call("/api/rooms", "POST", { owner: "y".repeat(5000) })).status, 400); // body over the limit

// presence: whoever polls with ?who= shows up
const seen = await call(`/api/rooms/${room.id}?who=${encodeURIComponent("Bia")}`);
assert.equal(seen.status, 200);
assert.deepEqual(seen.json.members.sort(), ["Ana", "Bia"]);

// change the BPM: new t0 (the instant of the change) and the same BPM for whoever polls later
await new Promise(r => setTimeout(r, 5));
const put = await call(`/api/rooms/${room.id}`, "PUT", { bpm: 90, who: "Bia" });
assert.equal(put.status, 200);
assert.equal(put.json.bpm, 90);
assert.ok(put.json.t0 > room.t0, "t0 must move forward with the new BPM");
assert.equal((await call(`/api/rooms/${room.id}`)).json.bpm, 90);

// invalid BPM
for (const bpm of [29, 241, 120.5, "abc", null, -1]) {
  const bad = await call(`/api/rooms/${room.id}`, "PUT", { bpm });
  assert.equal(bad.status, 422, `bpm ${JSON.stringify(bpm)} should be rejected`);
}
assert.equal((await call(`/api/rooms/${room.id}`, "PUT", {})).status, 422);
assert.equal((await call(`/api/rooms/${room.id}`, "PUT", "xx")).status, 400);
assert.equal((await call(`/api/rooms/${room.id}`, "DELETE")).status, 405);
assert.equal((await call(`/api/rooms/${room.id}`)).json.bpm, 90); // none of this changed the room

// unknown room
assert.equal((await call("/api/rooms/00000000-0000-4000-8000-000000000000")).status, 404);

// static files, the front-end route and the link previews
const home = await call("/");
assert.equal(home.status, 200);
assert.match(home.type, /text\/html/);
assert.ok(home.text.includes("<pulse-app>"));
assert.match(home.headers.get("content-security-policy"), /default-src 'self'/);
assert.ok(!home.text.includes("{{"), "every placeholder must be filled in");
assert.match(home.text, /<meta property="og:title" content="Global Metronome/);
assert.match(home.text, /<meta property="og:image" content="[^"]*\/og\.png">/);
for (const path of [`/room/${room.id}`, `/sala/${room.id}`]) { // /sala/ is the old path
  const page = await call(path);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes("<pulse-app>") && !page.text.includes("{{"));
  assert.match(page.text, /<meta property="og:title" content="Join Ana&#39;s room/);
  assert.ok(page.text.includes(`/room/${room.id}">`), "og:url points at the room");
}
// a name is user input: it must reach the page escaped
const evil = (await call("/api/rooms", "POST", { owner: `"><script>x</script>` })).json;
const evilPage = (await call(`/room/${evil.id}`)).text;
assert.ok(!evilPage.includes("<script>x") && evilPage.includes("&lt;script&gt;x"));
assert.match((await call("/room/00000000-0000-4000-8000-000000000000")).text, /og:title" content="Global Metronome/);
const og = await call("/og.png");
assert.equal(og.status, 200);
assert.match(og.type, /image\/png/);
assert.match((await call("/app.js")).type, /javascript/);
assert.equal((await call("/vendor/qrcode.js")).status, 200);
assert.equal((await call("/does-not-exist.js")).status, 404);
assert.equal((await call("/server.cr")).status, 404);

console.log("api ok");
