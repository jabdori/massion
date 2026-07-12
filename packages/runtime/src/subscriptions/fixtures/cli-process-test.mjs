const [, , mode, value] = process.argv;

if (mode === "echo") {
  process.stdout.write(value ?? "");
} else if (mode === "oversized") {
  process.stdout.write("x".repeat(4_096));
} else {
  process.exitCode = 2;
}
