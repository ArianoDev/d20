import { describe, expect, it } from "vitest";
import {
  filterGames,
  captureToken,
  localDate,
  participantsFromText,
} from "../src/components/data";

describe("UI data and privacy", () => {
  it("filters titles and supported player counts without changing the catalog", () => {
    const games = [
      {
        id: "1",
        title: "Azul",
        minPlayers: 2,
        maxPlayers: 4,
        duration: 45,
        complexity: 2,
        description: "",
        images: [],
        bggUrl: "",
        archived: false,
      },
    ];
    expect(filterGames(games, "AZ", "3", "", "")).toHaveLength(1);
    expect(filterGames(games, "", "5", "", "")).toHaveLength(0);
    expect(filterGames(games, "", "", "30", "")).toHaveLength(0);
    expect(games).toHaveLength(1);
  });
  it("captures a management fragment and immediately removes it without preserving a query", () => {
    const calls: unknown[][] = [];
    expect(
      captureToken(
        { hash: "#secret", pathname: "/manage" },
        { replaceState: (...args: unknown[]) => calls.push(args) },
      ),
    ).toBe("secret");
    expect(calls).toEqual([[null, "", "/manage"]]);
  });
  it("normalizes participant lines and formats dates in Rome", () => {
    expect(participantsFromText(" Ada \n\n Bruno ")).toEqual(["Ada", "Bruno"]);
    expect(localDate(new Date("2026-11-14T23:30:00Z"))).toBe("2026-11-15");
  });
});
