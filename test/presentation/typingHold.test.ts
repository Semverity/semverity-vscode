import { describe, expect, it } from "vitest";
import { decorationFor } from "../../src/presentation/decoration";
import { lineAfterEdit, TYPING_IDLE_MS, TypingHold } from "../../src/presentation/typingHold";
import { declaredIn, entry, target } from "../helpers/cards";
import { FakeClock } from "../helpers/fakeClock";

const URI = "file:///ws/src/a.ts";
const undeclared = (line: number) => entry({ line, target: target("lo", undefined, "latest") });

function setup() {
  const clock = new FakeClock();
  const released: string[] = [];
  const hold = new TypingHold((uri) => released.push(uri), clock);
  return { clock, released, hold };
}

describe("TypingHold", () => {
  it("holds undeclared imports on the line being typed until the cursor leaves it", () => {
    const { hold, released } = setup();
    hold.edited(URI, 3);
    expect(hold.holds(URI, undeclared(3))).toBe(true);
    expect(hold.holds(URI, undeclared(4))).toBe(false);
    // Declared dependencies and skipped entries are never held.
    expect(hold.holds(URI, entry({ line: 3, declaredIn: declaredIn() }))).toBe(false);
    expect(hold.holds(URI, entry({ line: 3, target: undefined }))).toBe(false);
    hold.cursorMoved(URI, 3);
    expect(released).toEqual([]);
    hold.cursorMoved(URI, 4);
    expect(released).toEqual([URI]);
    expect(hold.holds(URI, undeclared(3))).toBe(false);
  });

  it("releases after an idle period, on save, and when typing moves to another line", async () => {
    const { hold, released, clock } = setup();
    hold.edited(URI, 1);
    await clock.advance(TYPING_IDLE_MS - 1);
    hold.edited(URI, 1);
    await clock.advance(TYPING_IDLE_MS - 1);
    expect(released).toEqual([]);
    await clock.advance(1);
    expect(released).toEqual([URI]);

    hold.edited(URI, 2);
    hold.saved(URI);
    expect(released).toEqual([URI, URI]);

    hold.edited(URI, 5);
    hold.edited(URI, 6);
    expect(released).toEqual([URI, URI, URI]);
    expect(hold.holds(URI, undeclared(6))).toBe(true);
    hold.forget(URI);
    await clock.advance(TYPING_IDLE_MS * 2);
    expect(released).toHaveLength(3);
  });

  it("finds the line an edit ends on", () => {
    expect(lineAfterEdit(4, "x")).toBe(4);
    expect(lineAfterEdit(4, "\n")).toBe(5);
    expect(lineAfterEdit(4, "a\nb\nc")).toBe(6);
  });

  it("does not draw a held entry as scoring", () => {
    const settings = { decorations: true, showUnscored: true, scoreBasis: "headline" as const };
    expect(decorationFor([{ entry: undeclared(0) }], settings)?.text).toBe("scoring…");
    expect(decorationFor([{ entry: undeclared(0), held: true }], settings)).toBeUndefined();
  });
});
