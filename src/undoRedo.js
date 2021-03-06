/* eslint-disable no-param-reassign, no-shadow */

// Logic based on: https://github.com/anthonygore/vuex-undo-redo

const EMPTY_STATE = 'emptyState';
const UPDATE_CAN_UNDO_REO = 'updateCanUndoRedo';
const REDO = 'redo';
const UNDO = 'undo';

const noop = () => {};
export const undo = noop;
export const redo = noop;

export const scaffoldState = state => ({
  ...state,
  canUndo: false,
  canRedo: false,
});

export const scaffoldActions = actions => ({
  ...actions,
  undo,
  redo,
});

export const scaffoldMutations = mutations => ({
  ...mutations,
  updateCanUndoRedo: (state, payload) => {
    if (payload.canUndo !== undefined) state.canUndo = payload.canUndo;
    if (payload.canRedo !== undefined) state.canRedo = payload.canRedo;
  },
});

export const scaffoldStore = store => ({
  ...store,
  state: scaffoldState(store.state || {}),
  actions: scaffoldActions(store.actions || {}),
  mutations: scaffoldMutations(store.mutations || {}),
});

/**
 * The Undo-Redo plugin module
 *
 * @module store/plugins/undoRedo
 * @function
 * @param {Object} options
 * @param {String} options.namespace - The named vuex store module
 * @param {Array<String>} options.ignoreMutations - The list of store mutations
 * (belonging to the module) to be ignored
 * @returns {Function} plugin - the plugin function which accepts the store parameter
 */
export default (options = {}) => store => {
  const createPathConfig = ({ namespace = '', ignoreMutations = [] }) => ({
    namespace,
    ignoreMutations,
    done: [],
    undone: [],
    newMutation: true,
  });

  const paths = options.paths
    ? options.paths.map(({ namespace, ignoreMutations }) =>
        createPathConfig({
          namespace: `${namespace}/`,
          ignoreMutations: ignoreMutations
            .map(mutation => `${namespace}/${mutation}`)
            .concat(`${namespace}/${UPDATE_CAN_UNDO_REO}`),
        }),
      )
    : [
        createPathConfig({
          ignoreMutations: [
            ...(options.ignoreMutations || []),
            UPDATE_CAN_UNDO_REO,
          ],
        }),
      ];

  /**
   * Piping async action calls secquentially using Array.prototype.reduce
   * to chain and initial, empty promise
   *
   * @module store/plugins/undoRedo:getConfig
   * @function
   * @param {String} namespace - The name of the store module
   * @returns {Object} config - The object containing the undo/redo stacks of the store module
   */
  const getConfig = namespace =>
    paths.find(path => path.namespace === namespace) || {};

  const canRedo = namespace => {
    const config = getConfig(namespace);
    if (Object.keys(config).length) {
      return config.undone.length > 0;
    }
    return false;
  };

  const canUndo = namespace => {
    const config = getConfig(namespace);
    if (config) {
      return config.done.length > 0;
    }
    return false;
  };

  const updateCanUndoRedo = namespace => {
    const undoEnabled = canUndo(namespace);
    const redoEnabled = canRedo(namespace);

    store.commit(`${namespace}${UPDATE_CAN_UNDO_REO}`, {
      canUndo: undoEnabled,
    });
    store.commit(`${namespace}${UPDATE_CAN_UNDO_REO}`, {
      canRedo: redoEnabled,
    });
  };

  // Based on https://gist.github.com/anvk/5602ec398e4fdc521e2bf9940fd90f84
  /**
   * Piping async action calls secquentially using Array.prototype.reduce
   * to chain and initial, empty promise
   *
   * @module store/plugins/undoRedo:pipeActions
   * @function
   * @param {Array<Object>} actions - The array of objects containing the each
   * action's name and payload
   */
  const pipeActions = actions =>
    actions
      .filter(({ action }) => !!action)
      .reduce(
        (promise, { action, payload }) =>
          promise.then(() => store.dispatch(action, payload)),
        Promise.resolve(),
      );

  /**
   * Piping async action calls secquentially using Array.prototype.reduce
   * to chain and initial, empty promise
   *
   * @module store/plugins/undoRedo:setConfig
   * @function
   * @param {String} namespace - The name of the store module
   * @param {String} config - The object containing the updated undo/redo stacks of the store module
   */
  const setConfig = (namespace, config) => {
    const pathIndex = paths.findIndex(path => path.namespace === namespace);
    paths.splice(pathIndex, 1, config);
  };

  /**
   * The Redo function - commits the latest undone mutation to the store,
   * and pushes it to the done stack
   *
   * @module store/plugins/undoRedo:redo
   * @function
   */
  const redo = async namespace => {
    const config = getConfig(namespace);
    if (Object.keys(config).length) {
      let { undone } = config;

      const commit = undone.pop();
      // NB: Arbitrary name to identify mutations which have been grouped in a single action
      const { actionGroup } = commit.payload;
      const commits = [
        commit,
        ...(actionGroup
          ? undone.filter(
              m =>
                // Commit the mutation if it belongs to the same action group
                (m.payload.actionGroup &&
                  m.payload.actionGroup === actionGroup) ||
                // NB: Commit the mutation if it is not a grouped mutation
                !m.payload.actionGroup,
            )
          : []),
      ];

      // NB: The new redo stack to be updated in the config object
      undone = actionGroup
        ? undone.filter(
            m =>
              !m.payload.actionGroup ||
              (m.payload.actionGroup && m.payload.actionGroup !== actionGroup),
          )
        : [...undone];

      config.newMutation = false;
      // NB: The array of redoCallbacks and respective action payloads
      const redoCallbacks = commits.map(async ({ type, payload }) => {
        // NB: Commit each mutation in the redo stack
        store.commit(
          type,
          Array.isArray(payload) ? [...payload] : payload.constructor(payload),
        );

        // Check if there is an redo callback action
        const { redoCallback } = payload;
        // NB: The object containing the redoCallback action and payload
        return {
          action: redoCallback ? `${namespace}${redoCallback}` : '',
          payload,
        };
      });
      await pipeActions(await Promise.all(redoCallbacks));
      config.done = [...config.done, ...commits];
      config.newMutation = true;
      setConfig(namespace, {
        ...config,
        undone,
      });

      updateCanUndoRedo(namespace);
    }
  };

  /**
   * The Undo function - pushes the latest done mutation to the top of the undone
   * stack by popping the done stack and 'replays' all mutations in the done stack
   *
   * @module store/plugins/undoRedo:undo
   * @function
   */
  const undo = async namespace => {
    const config = getConfig(namespace);

    if (Object.keys(config).length) {
      let { undone, done } = config;

      const commit = done.pop();

      const { actionGroup } = commit.payload;
      const commits = [
        commit,
        ...(actionGroup
          ? done.filter(
              m =>
                m.payload.actionGroup && m.payload.actionGroup === actionGroup,
            )
          : []),
      ];

      // Check if there are any undo callback actions
      const undoCallbacks = commits.map(({ payload }) => ({
        action: payload.undoCallback
          ? `${namespace}${payload.undoCallback}`
          : '',
        payload,
      }));
      await pipeActions(undoCallbacks);

      done = [
        ...(actionGroup
          ? done.filter(
              m =>
                (m.payload.actionGroup &&
                  m.payload.actionGroup !== actionGroup) ||
                !m.payload.actionGroup,
            )
          : done),
      ];

      undone = [...undone, ...commits];
      config.newMutation = false;
      store.commit(`${namespace}${EMPTY_STATE}`);
      const redoCallbacks = done.map(async mutation => {
        store.commit(
          mutation.type,
          Array.isArray(mutation.payload)
            ? [...mutation.payload]
            : mutation.payload.constructor(mutation.payload),
        );

        // Check if there is an undo callback action
        const { redoCallback } = mutation.payload;
        return {
          action: redoCallback ? `${namespace}${redoCallback}` : '',
          payload: mutation.payload,
        };
      });
      await pipeActions(await Promise.all(redoCallbacks));
      config.newMutation = true;
      setConfig(namespace, {
        ...config,
        done,
        undone,
      });

      updateCanUndoRedo(namespace);
    }
  };

  store.subscribe(mutation => {
    const isStoreNamespaced = mutation.type.split('/').length > 1;
    const namespace = isStoreNamespaced
      ? `${mutation.type.split('/')[0]}/`
      : '';
    const config = getConfig(namespace);

    if (Object.keys(config).length) {
      const { ignoreMutations, newMutation, done } = config;

      if (
        mutation.type !== `${namespace}${EMPTY_STATE}` &&
        mutation.type !== `${namespace}${UPDATE_CAN_UNDO_REO}` &&
        ignoreMutations.indexOf(mutation.type) === -1 &&
        mutation.type.includes(namespace) &&
        newMutation
      ) {
        done.push(mutation);
        setConfig(namespace, {
          ...config,
          done,
        });
        updateCanUndoRedo(namespace);
      }
    }
  });

  // NB: Watch all actions to intercept the undo/redo NOOP actions
  store.subscribeAction(async action => {
    const isStoreNamespaced = action.type.split('/').length > 1;
    const namespace = isStoreNamespaced ? `${action.type.split('/')[0]}/` : '';

    switch (action.type) {
      case `${namespace}${REDO}`:
        if (canRedo(namespace)) await redo(namespace);
        break;
      case `${namespace}${UNDO}`:
        if (canUndo(namespace)) await undo(namespace);
        break;
      default:
        break;
    }
  });
};
