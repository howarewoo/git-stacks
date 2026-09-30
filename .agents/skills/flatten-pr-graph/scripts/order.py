#!/usr/bin/env python3
"""Read-only, dependency-constrained PR ordering. Python 3.10+, stdlib only.

Input contains positive PR numbers, [parent, child] dependencies, and a complete
transition-cost matrix. Costs are [conflict_risk, merge_commits, base_changes].
Exact results certify this supplied pairwise objective, not cumulative merges.
This helper never invokes git, contacts GitHub, runs checks, or changes files.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

Cost = tuple[int, int, int]
Record = tuple[Cost, tuple[int, ...]]


def validate(data: Any) -> tuple[list[int], list[int], dict[str, dict[str, Cost]]]:
    if not isinstance(data, dict):
        raise ValueError("input must be a JSON object")
    prs = data.get("prs")
    if not isinstance(prs, list) or not prs:
        raise ValueError("prs must be a nonempty list")
    if any(type(p) is not int or p <= 0 for p in prs):
        raise ValueError("PR numbers must be positive integers")
    if len(set(prs)) != len(prs):
        raise ValueError("duplicate PR numbers; canonicalize inputs first")
    prs = sorted(prs)
    index = {p: i for i, p in enumerate(prs)}
    required = [0] * len(prs)
    dependencies = data.get("dependencies", [])
    if not isinstance(dependencies, list):
        raise ValueError("dependencies must be a list")
    for edge in dependencies:
        if not isinstance(edge, list) or len(edge) != 2:
            raise ValueError("each dependency must be [parent, child]")
        a, b = edge
        if any(type(p) is not int or p not in index for p in edge):
            raise ValueError(f"dependency outside selected PRs: {edge!r}")
        if a == b:
            raise ValueError(f"self-dependency: {a}")
        required[index[b]] |= 1 << index[a]
    visited = 0
    while True:
        ready = [i for i, mask in enumerate(required)
                 if not visited & (1 << i) and mask & visited == mask]
        if not ready:
            break
        for i in ready:
            visited |= 1 << i
    if visited != (1 << len(prs)) - 1:
        blocked = [p for i, p in enumerate(prs) if not visited & (1 << i)]
        raise ValueError(f"dependency cycle; blocked PRs: {blocked}")

    raw = data.get("costs")
    if not isinstance(raw, dict):
        raise ValueError("costs must be a complete transition matrix")
    costs: dict[str, dict[str, Cost]] = {}
    # Requiring even unreachable transitions prevents missing data from quietly
    # becoming a zero-cost edge or a hidden pruning rule.
    for source in ["base", *(str(p) for p in prs)]:
        row = raw.get(source)
        if not isinstance(row, dict):
            raise ValueError(f"missing cost row: {source}")
        costs[source] = {}
        for p in prs:
            target = str(p)
            if source == target:
                continue
            value = row.get(target)
            if (not isinstance(value, list) or len(value) != 3
                    or any(type(x) is not int or x < 0 for x in value)):
                raise ValueError(f"cost {source}->{target} needs 3 nonnegative integers")
            costs[source][target] = (value[0], value[1], value[2])
    return prs, required, costs


def plan(data: Any, exact_limit: int = 14, beam_width: int = 256) -> dict[str, Any]:
    if type(exact_limit) is not int or not 0 <= exact_limit <= 18:
        raise ValueError("exact_limit must be between 0 and 18")
    if type(beam_width) is not int or beam_width < 1:
        raise ValueError("beam_width must be positive")
    prs, required, costs = validate(data)
    exact = len(prs) <= exact_limit
    states: dict[tuple[int, int], Record] = {(0, -1): ((0, 0, 0), ())}
    expanded = 0
    pruned = False
    for _ in prs:
        following: dict[tuple[int, int], Record] = {}
        for (mask, last), (score, path) in states.items():
            source = "base" if last == -1 else str(prs[last])
            for i, p in enumerate(prs):
                bit = 1 << i
                if mask & bit or required[i] & mask != required[i]:
                    continue
                edge = costs[source][str(p)]
                record: Record = (
                    (score[0] + edge[0], score[1] + edge[1], score[2] + edge[2]),
                    path + (p,),
                )
                key = (mask | bit, i)
                expanded += 1
                if key not in following or record < following[key]:
                    following[key] = record
        if not following:
            raise ValueError("no dependency-respecting order")
        if not exact and len(following) > beam_width:
            following = dict(sorted(following.items(), key=lambda item: item[1])[:beam_width])
            pruned = True
        states = following
    score, order = min(states.values())
    return {
        "order": list(order),
        "score": dict(zip(("conflict_risk", "merge_commits", "base_changes"), score)),
        "search": "exact" if exact else "beam",
        "optimal_for_supplied_costs": not pruned,
        "expanded_transitions": expanded,
        "caveat": "Pairwise costs are a proxy; cumulative merges and semantic resolutions may differ.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="plan JSON path, or - for stdin")
    parser.add_argument("--exact-limit", type=int, default=14)
    parser.add_argument("--beam-width", type=int, default=256)
    args = parser.parse_args()
    try:
        text = sys.stdin.read() if args.input == "-" else Path(args.input).read_text(encoding="utf-8")
        result = plan(json.loads(text), args.exact_limit, args.beam_width)
    except (OSError, UnicodeError, ValueError) as exc:
        print(f"flatten-pr-graph: {exc}", file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
