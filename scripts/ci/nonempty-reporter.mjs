export default class NonemptyReporter {
  onBegin(_config, suite) {
    // Runtime test.skip() mutates expectedStatus after discovery.
    this.runnable = suite.allTests().filter((test) => test.expectedStatus !== 'skipped')
    this.files = new Set(this.runnable.map((test) => test.location.file))
  }

  onEnd(result) {
    const executed = new Set(
      this.runnable
        .filter((test) => test.results.some((run) => run.status !== 'skipped'))
        .map((test) => test.location.file),
    )
    if (!this.runnable.length || [...this.files].some((file) => !executed.has(file))) {
      console.error('Selected Playwright workload executed zero tests in one or more files')
      return { status: 'failed' }
    }
    return { status: result.status }
  }
}
