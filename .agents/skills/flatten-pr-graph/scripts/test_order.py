"""Planner regression tests; not invoked when flattening PRs."""
import itertools
import random
import unittest

from order import plan


def fixture(prs, dependencies=(), seed=1):
    rng = random.Random(seed)
    return {
        "prs": list(prs),
        "dependencies": [list(edge) for edge in dependencies],
        "costs": {
            source: {str(p): [rng.randrange(4), rng.randrange(2), rng.randrange(2)]
                     for p in prs if str(p) != source}
            for source in ["base", *(str(p) for p in prs)]
        },
    }


def score(data, order):
    total = [0, 0, 0]
    source = "base"
    for p in order:
        total = [a + b for a, b in zip(total, data["costs"][source][str(p)])]
        source = str(p)
    return tuple(total), tuple(order)


class OrderingTests(unittest.TestCase):
    def test_exact_matches_exhaustive_search(self):
        for seed in range(12):
            data = fixture(range(1, 7), [(1, 3), (2, 3), (3, 6), (4, 5)], seed)
            valid = [order for order in itertools.permutations(data["prs"])
                     if all(order.index(a) < order.index(b) for a, b in data["dependencies"])]
            expected = min(valid, key=lambda order: score(data, order))
            result = plan(data)
            self.assertEqual(result["order"], list(expected))
            self.assertTrue(result["optimal_for_supplied_costs"])

    def test_ties_are_independent_of_input_order(self):
        data = fixture([3, 1, 2])
        for row in data["costs"].values():
            for target in row:
                row[target] = [0, 0, 0]
        self.assertEqual(plan(data)["order"], [1, 2, 3])

    def test_dependencies_override_cheaper_order(self):
        data = fixture([1, 2, 3], [(3, 2), (2, 1)])
        self.assertEqual(plan(data)["order"], [3, 2, 1])

    def test_lexicographic_objective(self):
        data = fixture([1, 2])
        data["costs"] = {"base": {"1": [0, 0, 0], "2": [0, 0, 0]},
                         "1": {"2": [0, 100, 100]}, "2": {"1": [1, 0, 0]}}
        self.assertEqual(plan(data)["order"], [1, 2])
        data["costs"]["2"]["1"] = [0, 99, 1000]
        self.assertEqual(plan(data)["order"], [2, 1])

    def test_single_pr(self):
        self.assertEqual(plan(fixture([4]))["order"], [4])

    def test_cycle(self):
        with self.assertRaisesRegex(ValueError, "cycle"):
            plan(fixture([1, 2], [(1, 2), (2, 1)]))

    def test_unknown_dependency(self):
        with self.assertRaisesRegex(ValueError, "outside selected"):
            plan(fixture([1, 2], [(9, 2)]))

    def test_missing_cost(self):
        data = fixture([1, 2])
        del data["costs"]["1"]["2"]
        with self.assertRaisesRegex(ValueError, "cost 1->2"):
            plan(data)

    def test_invalid_inputs(self):
        for data in [None, {}, {"prs": []}, {"prs": [1, 1]}, {"prs": [True]}]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                plan(data)
        data = fixture([1, 2])
        data["costs"]["base"]["1"] = [-1, 0, 0]
        with self.assertRaises(ValueError):
            plan(data)

    def test_beam_respects_diamond_and_reports_pruning(self):
        edges = [(1, 3), (2, 3), (3, 5), (4, 5)]
        data = fixture(range(1, 9), edges)
        result = plan(data, exact_limit=0, beam_width=2)
        order = result["order"]
        self.assertEqual(sorted(order), list(range(1, 9)))
        self.assertTrue(all(order.index(a) < order.index(b) for a, b in edges))
        self.assertEqual(result["search"], "beam")
        self.assertFalse(result["optimal_for_supplied_costs"])

    def test_unpruned_beam_can_certify_objective(self):
        result = plan(fixture([1, 2, 3], [(1, 2), (2, 3)]), exact_limit=0, beam_width=1)
        self.assertTrue(result["optimal_for_supplied_costs"])

    def test_invalid_search_limits(self):
        for kwargs in [{"exact_limit": -1}, {"exact_limit": 19}, {"beam_width": 0}]:
            with self.assertRaises(ValueError):
                plan(fixture([1]), **kwargs)


if __name__ == "__main__":
    unittest.main()
