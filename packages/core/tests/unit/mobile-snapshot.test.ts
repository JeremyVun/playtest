// Mobile accessibility-tree parsing is deterministic and independent of model
// behavior. Actor-driven mobile runs were removed with the rule-based mock model.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePageSource } from "../../src/drivers/mobile-snapshot.ts";

test("parsePageSource: iOS AX tree → [eN] text + durable accessibility-id locators + bbox", () => {
  const xml =
    `<XCUIElementTypeApplication name="Todos">` +
    `<XCUIElementTypeTextField name="What needs doing?" value="milk" x="20" y="50" width="280" height="40" visible="true"/>` +
    `<XCUIElementTypeButton name="Add" x="300" y="50" width="60" height="40" visible="true"/>` +
    `<XCUIElementTypeCell name="buy milk" x="20" y="100" width="340" height="40" visible="true"/>` +
    `<XCUIElementTypeStaticText name="1 item left" x="20" y="150" width="200" height="20" visible="true"/>` +
    `</XCUIElementTypeApplication>`;
  const snap: LegacyTestValue = parsePageSource(xml);
  assert.match(snap.text, /^Screen: Todos/);
  assert.equal(snap.title, "Todos");
  assert.equal(snap.refCount, 3);
  assert.match(snap.text, /\[e1\] textfield "What needs doing\?" value="milk"/);
  assert.match(snap.text, /\[e2\] button "Add"/);
  assert.match(snap.text, /\[e3\] cell "buy milk"/);
  assert.match(snap.text, /text: "1 item left"/);
  const field = snap.elements[0];
  assert.equal(field.locator, "~What needs doing?");
  assert.deepEqual(field.bbox, { x: 20, y: 50, w: 280, h: 40 });
  assert.equal(field.typable, true);
  assert.equal(snap.elements[2].locator, "~buy milk");
});

// The rendered name is what the actor reads, so it must be the human string.
// XCUITest reports the accessibility IDENTIFIER as `name` whenever the app sets
// one, which is why `label` wins and the identifier survives only as the locator.
test("parsePageSource: iOS renders the human label, not the identifier, and keeps identifier locators", () => {
  const xml =
    `<XCUIElementTypeApplication name="Todos" label="Todos">` +
    `<XCUIElementTypeButton name="todo-row-1" label="Buy milk" value="active" x="16" y="222" width="256" height="26" visible="true"/>` +
    `<XCUIElementTypeStaticText name="todo-status-1" label="active" x="284" y="227" width="34" height="15" visible="true"/>` +
    `<XCUIElementTypeButton name="delete-1" label="Delete Buy milk" x="330" y="225" width="47" height="20" visible="true"/>` +
    `<XCUIElementTypeTextField name="todo-input" label="" value="New todo" x="16" y="161" width="317" height="35" visible="true"/>` +
    `</XCUIElementTypeApplication>`;
  const snap: LegacyTestValue = parsePageSource(xml);
  // A button's accessibility VALUE carries its state on iOS; it renders for
  // every role, parenthesized, not just for switches.
  assert.match(snap.text, /\[e1\] button "Buy milk" \(active\)/);
  assert.match(snap.text, /\[e2\] button "Delete Buy milk"/);
  assert.match(snap.text, /text: "active"/);
  assert.doesNotMatch(snap.text, /todo-row-1|todo-status-1|delete-1/, `identifiers leaked into the rendered text:\n${snap.text}`);
  // An unlabelled control (iOS reports label="" for a TextField) still falls
  // back to `name`, and typable value rendering is unchanged.
  assert.match(snap.text, /\[e3\] textfield "todo-input" value="New todo"/);
  // The identifier remains the LOCATOR surface — that is what act mode replays.
  assert.deepEqual(snap.elements.map((e: LegacyTestValue) => e.locator), ["~todo-row-1", "~delete-1", "~todo-input"]);

  // The value is part of the rendered line, so a state flip is real drift.
  const flipped: LegacyTestValue = parsePageSource(xml.replace('value="active"', 'value="completed"'));
  assert.match(flipped.text, /\[e1\] button "Buy milk" \(completed\)/);
  assert.notEqual(flipped.text, snap.text, "a value-only state change must change the snapshot text");
});

test("parsePageSource: Android bounds + content-desc, and never throws on junk", () => {
  const xml =
    `<android.widget.FrameLayout>` +
    `<android.widget.Button content-desc="Add" bounds="[300,50][360,90]"/>` +
    `<android.widget.EditText resource-id="com.x:id/new" text="" bounds="[20,50][280,90]"/>` +
    `</android.widget.FrameLayout>`;
  const snap: LegacyTestValue = parsePageSource(xml);
  assert.equal(snap.elements.find((e: LegacyTestValue) => e.role === "button").bbox.w, 60);
  assert.doesNotThrow(() => parsePageSource("<not really <xml"));
  assert.doesNotThrow(() => parsePageSource(null as LegacyTestValue)); // SAFETY: deliberately invalid input pins runtime tolerance
});
