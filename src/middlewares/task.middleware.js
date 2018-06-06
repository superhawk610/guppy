import {
  RUN_TASK,
  ABORT_TASK,
  COMPLETE_TASK,
  LAUNCH_DEV_SERVER,
  abortTask,
  completeTask,
  attachProcessIdToTask,
  receiveDataFromTaskExecution,
} from '../actions';
import { getProjectById } from '../reducers/projects.reducer';
import { getTaskByProjectIdAndTaskName } from '../reducers/tasks.reducer';
import findAvailablePort from '../services/find-available-port.service';

const childProcess = window.require('child_process');
const os = window.require('os');
const psTree = window.require('ps-tree');

// When the app first loads, we need to get an index of existing projects.
// The default path for projects is `~/guppy-projects`.
// TODO: Make this configurable, should live in Redux!
const parentPath = `${os.homedir()}/guppy-projects`;

// HACK:
// The tests by default run in an interactive "watch" mode.
// it would be GREAT to create a whole GUI for this, but that's so much work.
// And without that work, the test-running would be totally broken.
// So instead, I'm gonna force it into "just run all the tests once" mode :(
// This is bad, and I should feel bad. Hopefully we'll fix this though!
const getAdditionalArgsForTask = task => {};

export default store => next => action => {
  if (!action.task) {
    return next(action);
  }

  const { task } = action;

  switch (action.type) {
    case LAUNCH_DEV_SERVER: {
      findAvailablePort()
        .then(port => {
          /**
           * NOTE: Ideally, we would use the following command:
           *
              childProcess.spawn(
                `npm`,
                ['run', name],
                {
                  cwd: `${parentPath}/${projectId}`,
                  env: { PORT: port },
                }
              );
           *
           * The difference is that we're not using "shell" mode, and we're
           * specifying the port number as an environment variable.
           *
           * Because of a likely bug in Electron, the `env` option for
           * childProcess causes everything to blow up. I added a comment here:
           * https://github.com/electron/electron/issues/3627
           *
           * As a workaround, I'm using "shell mode" to avoid having to
           * specify environment variables:
           */

          const child = childProcess.spawn(
            `PORT=${port} npm`,
            ['run', task.name],
            {
              cwd: `${parentPath}/${task.projectId}`,
              shell: true,
            }
          );

          // To abort this task, we'll need access to its processId (pid).
          // Attach it to the task.
          next(attachProcessIdToTask(task, child.pid));

          child.stdout.on('data', data => {
            // Ok so, unfortunately, failure-to-compile is still pushed
            // through stdout, not stderr. We want that message specifically
            // to trigger an error state, and so we need to parse it.
            const text = data.toString();

            const isError = text.includes('Failed to compile.');

            next(receiveDataFromTaskExecution(task, text, isError));
          });

          child.stderr.on('data', data => {
            next(receiveDataFromTaskExecution(task, data.toString()));
          });

          child.on('exit', code => {
            const timestamp = new Date();
            store.dispatch(completeTask(task, timestamp, code === 0));
          });
        })
        .catch(err => {
          // TODO: Error handling (this can happen if the first 15 ports are
          // occupied, or if there's some generic Node error)
          console.error(err);
        });

      break;
    }

    case RUN_TASK: {
      const { projectId, name } = action.task;

      const project = getProjectById(projectId, store.getState());

      // TEMPORARY HACK
      // By default, create-react-app runs tests in interactive watch mode.
      // This is a brilliant way to do it, but it's interactive, which won't
      // work as-is.
      // In the future, I expect "Tests" to get its own module on the project
      // page, in which case we can support the interactive mode, except with
      // descriptive buttons instead of cryptic letters!
      // Alas, this would be mucho work, and this is an MVP. So for now, I'm
      // disabling watch mode, and doing "just run all the tests once" mode.
      // This is bad, and I feel bad, but it's a corner that needs to be cut,
      // for now.
      const additionalArgs = [];
      if (project.type === 'create-react-app' && name === 'test') {
        additionalArgs.push('--', '--coverage');
      }

      console.log(additionalArgs, project.type, name);

      const child = childProcess.spawn(
        `npm`,
        ['run', name, ...additionalArgs],
        {
          cwd: `${parentPath}/${projectId}`,
          shell: true,
        }
      );

      // To abort this task, we'll need access to its processId (pid).
      // Attach it to the task.
      next(attachProcessIdToTask(task, child.pid));

      child.stdout.on('data', data => {
        next(receiveDataFromTaskExecution(task, data.toString()));
      });

      child.stderr.on('data', data => {
        next(receiveDataFromTaskExecution(task, data.toString()));
      });

      child.on('exit', code => {
        const timestamp = new Date();

        store.dispatch(completeTask(task, timestamp, code === 0));
      });

      break;
    }

    case ABORT_TASK: {
      const { task } = action;
      const { projectId, processId, name } = task;

      // Our child was spawned using `shell: true` to get around a quirk with
      // electron not working when specifying environment variables the
      // "correct" way (see comment above).
      //
      // Because of that, `child.pid` refers to the `sh` command that spawned
      // the actual Node process, and so we need to use `psTree` to build a
      // tree of descendent children and kill them that way.
      psTree(processId, (err, children) => {
        if (err) {
          console.error('Could not gather process children:', err);
        }

        const childrenPIDs = children.map(child => child.PID);

        childProcess.spawn('kill', ['-9', ...childrenPIDs]);

        // Once the children are killed, we should dispatch a notification
        // so that the terminal shows something about this update.
        // My initial thought was that all tasks would have the same message,
        // but given that we're treating `start` as its own special thing,
        // I'm realizing that it should vary depending on the task type.
        // TODO: Find a better place for this to live.
        // TODO: How will this work with Gatsby, when the 'start' task is
        // different?
        const abortMessage =
          name === 'start' ? 'Server stopped' : 'Task aborted';

        next(
          receiveDataFromTaskExecution(
            task,
            `\u001b[31;1m${abortMessage}\u001b[0m`
          )
        );
      });

      break;
    }

    case COMPLETE_TASK: {
      const { task } = action;

      // Send a message to add info to the terminal about the task being done.
      // TODO: ASCII fish art?

      const message = 'Task completed';

      next(
        receiveDataFromTaskExecution(task, `\u001b[32;1m${message}\u001b[0m`)
      );

      break;
    }
  }

  // Pass all actions through
  return next(action);
};