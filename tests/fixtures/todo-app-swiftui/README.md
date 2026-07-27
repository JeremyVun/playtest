# todo-app-swiftui

A deliberately minimal SwiftUI todo app for the **iOS Simulator**. It is the
subject Playtest's mobile driver (Appium/XCUITest) drives, and its only job is
to present a clean, deterministic accessibility tree to XCUITest page-source.

One screen, in-memory state, no persistence, no network, no clock, no
randomness, no locale-dependent formatting. Appium's default session reset
reinstalls the app, so every run starts from the same three seed todos.

| | |
|---|---|
| Bundle id | `dev.playtest.todo-fixture` |
| Deployment target | iOS 17.0 |
| Device family | iPhone, portrait only |
| Built product | `build/TodoFixture.app` (gitignored) |

## Build

```sh
tests/fixtures/todo-app-swiftui/build.sh
```

Quiet on success; the final line of stdout is the absolute path of the built
`.app`, which is what a harness should consume:

```sh
APP_PATH="$(tests/fixtures/todo-app-swiftui/build.sh | tail -1)"
```

The script is rerunnable and removes the previous bundle each time. It compiles
with `xcrun swiftc` against the iphonesimulator SDK and assembles the bundle by
hand — no Xcode project, and no signing, because simulator apps run unsigned.
It builds for the host architecture; override with `TODO_FIXTURE_ARCH=x86_64`
on an Intel host.

Requires Xcode with an iOS Simulator SDK installed (developed against Xcode
26.4 / iOS 26.4 SDK, verified running on an iOS 18.3 simulator).

## Run it by hand

```sh
UDID="$(xcrun simctl list devices available | grep -m1 'iPhone 16 (' | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"
xcrun simctl boot "$UDID"
xcrun simctl install "$UDID" "$(tests/fixtures/todo-app-swiftui/build.sh | tail -1)"
xcrun simctl launch "$UDID" dev.playtest.todo-fixture
xcrun simctl shutdown "$UDID"
```

## Seed data

Hard-coded in `Sources/TodoFixtureApp.swift`:

| id | title | state |
|---|---|---|
| 1 | Buy milk | active |
| 2 | Walk the dog | active |
| 3 | Write the report | completed |

Ids are monotonic and never reused. Added todos start at id 4 and count up
within the process lifetime; deleting a todo does not renumber the others.

## Accessibility identifier inventory

Every interactive element has a stable `.accessibilityIdentifier`. The `<id>`
suffix is the todo's id above — **not** its row position — so identifiers
survive deletion of other rows.

| Identifier | Element type | Notes |
|---|---|---|
| `app-title` | StaticText | Always the literal `Playtest Todos` |
| `remaining-count` | StaticText | e.g. `2 remaining`; counts not-completed todos |
| `todo-input` | TextField | Placeholder `New todo`; autocorrect and autocapitalization off |
| `add-button` | Button | Label `Add`; appends the trimmed input and clears it. A blank or whitespace-only input is a no-op |
| `todo-list` | ScrollView | Container for the rows |
| `todo-row-<id>` | Button | Tapping toggles completion. Accessibility **label** is the todo title; accessibility **value** is `completed` or `active` |
| `todo-status-<id>` | StaticText | The same state string, `completed` or `active`, as a sibling element of the row button |
| `delete-<id>` | Button | Visible text `Delete`; accessibility label `Delete <title>`. Removes the todo immediately, with no confirmation |

Completion state is therefore readable two ways — as `todo-row-<id>`'s value and
as `todo-status-<id>`'s text — so a harness never has to infer state from color.

## Notes for a harness author

- Delete is an explicit button, not swipe-to-delete. There is no swipe gesture
  anywhere in the app and nothing needs a long-press.
- Rows are a `ScrollView` + `LazyVStack`, not a `List`, so the page source has
  no table/cell wrapper layer. With only a handful of todos nothing scrolls
  offscreen on an iPhone-sized device, but `LazyVStack` means a very long list
  would only materialize visible rows in the tree.
- `todo-row-<id>` merges its icon and title into a single accessibility
  element, so the title is that element's label rather than a child StaticText.
- After tapping `add-button`, `todo-input` is empty again and the new row is
  appended at the bottom.
- The keyboard's return key is configured as Done; it dismisses the keyboard
  and does **not** submit. Use `add-button` to add a todo.
- Portrait only — orientation will not change under the app.
