export function tabsReducer(state, action) {
  if (action.type !== "close") {
    return state;
  }

  return {
    tabs: state.tabs.filter((tab) => tab.id !== action.id),
    selectedId: state.selectedId
  };
}
