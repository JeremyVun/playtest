// A case child that dies on its own, without anybody cancelling it: the shape a
// crashed engine or a missing dependency takes. Its stderr first line is what
// the executor turns into an `infra` report.
const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", () => {
  process.stderr.write("the case child could not start: no such module\nand a second line nobody reads\n");
  process.exit(7);
});
