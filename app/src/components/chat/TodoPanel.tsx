import { memo, useMemo } from "react";
import type { ChatMessage, TodoItem } from "../../types";

interface Props {
  messages: ChatMessage[];
}

export default memo(function TodoPanel({ messages }: Props) {
  // Get the most recent todo list from messages
  const todos = useMemo(() => {
    const todoMessages = messages.filter((m) => m.role === "todo");
    const latestTodo = todoMessages[todoMessages.length - 1];
    return (latestTodo?.role === "todo" ? latestTodo.todos : []) as TodoItem[];
  }, [messages]);

  if (todos.length === 0) {
    return <div className="sidebar-empty"><span className="sidebar-empty-icon">{"\u2610"}</span>No tasks yet</div>;
  }

  return (
    <div className="todo-panel">
      {todos.map((todo) => (
        <div key={todo.id} className={`todo-item todo-${todo.status}`}>
          <span className="todo-check">
            {todo.status === "completed" ? "\u2611" : todo.status === "in_progress" ? "\u25C9" : "\u2610"}
          </span>
          <span className={`todo-title${todo.status === "completed" ? " done" : ""}`}>
            {todo.title}
          </span>
          {todo.category && (
            <span className="todo-category">{todo.category}</span>
          )}
        </div>
      ))}
    </div>
  );
});
