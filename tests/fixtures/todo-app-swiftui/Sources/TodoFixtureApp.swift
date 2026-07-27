import SwiftUI

/// A todo item. `id` is a monotonic integer that is also the suffix of every
/// accessibility identifier belonging to this row, so identifiers stay stable
/// when other rows are deleted.
struct Todo: Identifiable {
    let id: Int
    var title: String
    var completed: Bool
}

/// Deterministic seed data. Hard-coded on purpose: no persistence, no clock, no
/// locale-dependent formatting, no randomness. Appium's default session reset
/// reinstalls the app, so every run starts from exactly this state.
let seedTodos: [Todo] = [
    Todo(id: 1, title: "Buy milk", completed: false),
    Todo(id: 2, title: "Walk the dog", completed: false),
    Todo(id: 3, title: "Write the report", completed: true)
]

final class TodoStore: ObservableObject {
    @Published var todos: [Todo] = seedTodos
    @Published var draft: String = ""

    /// Next id continues past the seed data and never reuses a deleted id.
    private var nextId: Int = 4

    var remainingCount: Int {
        todos.filter { !$0.completed }.count
    }

    func add() {
        let title = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        todos.append(Todo(id: nextId, title: title, completed: false))
        nextId += 1
        draft = ""
    }

    func toggle(_ id: Int) {
        guard let index = todos.firstIndex(where: { $0.id == id }) else { return }
        todos[index].completed.toggle()
    }

    func delete(_ id: Int) {
        todos.removeAll { $0.id == id }
    }
}

struct TodoRow: View {
    let todo: Todo
    let onToggle: () -> Void
    let onDelete: () -> Void

    /// "completed" / "active" — the machine-readable state string. It is both
    /// the row's accessibility value and the text of its own status element.
    private var stateText: String {
        todo.completed ? "completed" : "active"
    }

    var body: some View {
        HStack(spacing: 12) {
            // The toggle target. Its children are merged into one element, so
            // the status string is exposed as this element's accessibility
            // value rather than as a descendant.
            Button(action: onToggle) {
                HStack(spacing: 12) {
                    Image(systemName: todo.completed ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 22))
                        .foregroundColor(todo.completed ? .green : .secondary)
                    Text(todo.title)
                        .font(.body)
                        .foregroundColor(.primary)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("todo-row-\(todo.id)")
            .accessibilityLabel(todo.title)
            .accessibilityValue(stateText)

            // A sibling of the button, not a descendant, so it is always its
            // own StaticText element in the page source.
            Text(stateText)
                .font(.caption)
                .foregroundColor(.secondary)
                .accessibilityIdentifier("todo-status-\(todo.id)")

            Button(action: onDelete) {
                Text("Delete")
                    .font(.callout)
                    .foregroundColor(.red)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("delete-\(todo.id)")
            .accessibilityLabel("Delete \(todo.title)")
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 16)
    }
}

struct ContentView: View {
    @StateObject private var store = TodoStore()

    var body: some View {
        VStack(spacing: 0) {
            Text("Playtest Todos")
                .font(.largeTitle.bold())
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.top, 24)
                .accessibilityIdentifier("app-title")

            Text("\(store.remainingCount) remaining")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .accessibilityIdentifier("remaining-count")

            HStack(spacing: 12) {
                TextField("New todo", text: $store.draft)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled(true)
                    .textInputAutocapitalization(.never)
                    .submitLabel(.done)
                    .accessibilityIdentifier("todo-input")

                Button(action: store.add) {
                    Text("Add")
                        .font(.body.weight(.semibold))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("add-button")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 16)

            Divider()

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(store.todos) { todo in
                        TodoRow(
                            todo: todo,
                            onToggle: { store.toggle(todo.id) },
                            onDelete: { store.delete(todo.id) }
                        )
                        Divider()
                    }
                }
            }
            .accessibilityIdentifier("todo-list")

            Spacer(minLength: 0)
        }
    }
}

@main
struct TodoFixtureApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
