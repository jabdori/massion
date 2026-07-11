export class ShutdownSignalController {
  private count = 0;

  public receive(): "drain" | "force" {
    this.count += 1;
    return this.count === 1 ? "drain" : "force";
  }
}
