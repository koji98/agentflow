export function createWorkflowRunner(definition, runners) {
  const tasks = Array.isArray(definition?.tasks) ? definition.tasks : [];

  return {
    async run(initialContext = {}) {
      const results = {};
      const taskResults = {};
      const order = [];

      for (const task of tasks) {
        const runner = runners[task.run];
        order.push(task.id);
        const value = await runner(initialContext, task);
        results[task.id] = value;
        taskResults[task.id] = {
          status: "passed",
          attempts: 1,
          result: value
        };
      }

      return {
        status: "passed",
        order,
        results,
        tasks: taskResults
      };
    }
  };
}
