const response = await fetch(process.env.BASE_URL + "/api/reset", {
  method: "POST",
});

if (!response.ok) {
  throw new Error("todo-app reset failed: HTTP " + response.status);
}
