import type { LiveScenario } from '../scenario'
import { nativeStackScenarios } from './native-stacks'
import { reviewScenarios } from './reviews'
import { checkScenarios, mergeScenarios } from './checks-and-merge'
import { raceScenarios } from './races'
import { faultScenarios, ruleScenarios } from './rules-and-faults'

/**
 * Every scenario the suite knows about, in the order a run executes them.
 *
 * The order is deliberate. Stacks come first because they are the feature the rest
 * of the suite stands on, then the write paths that need an open pull request,
 * then the races that need a reviewed plan to race against, and finally the fault
 * and reporting contracts, which need nothing but the transport. A run that stops
 * early therefore loses the least coverage rather than the most.
 */
export const LIVE_SCENARIOS: readonly LiveScenario[] = [
  ...nativeStackScenarios,
  ...reviewScenarios,
  ...checkScenarios,
  ...ruleScenarios,
  ...mergeScenarios,
  ...raceScenarios,
  ...faultScenarios,
]

/** One scenario by id, which is what `--only` selects. */
export function findScenario(id: string): LiveScenario | undefined {
  return LIVE_SCENARIOS.find((scenario) => scenario.id === id)
}
