import { AppRegistry } from "react-native";
import App from "./App";
import "./global.css";
import { installScrollActivityTracking } from "./scrollActivity";
import { takeDetachedTab } from "./tabWindows";

const rootTag = document.getElementById("root");

if (!rootTag) {
  throw new Error("Nomi root element was not found");
}

AppRegistry.registerComponent("Nomi", () => App);

const stopScrollActivityTracking = installScrollActivityTracking();
if (import.meta.hot) {
  import.meta.hot.dispose(stopScrollActivityTracking);
}

// A window torn off from a tab carries that tab's state. Claim it before the
// first paint so the window opens on the right view instead of flashing 对话;
// the main window resolves this immediately, without an IPC round-trip.
void takeDetachedTab().then((detachedTab) => {
  AppRegistry.runApplication("Nomi", {
    initialProps: { detachedTab },
    // Runtime is react-native-web; React Native's bundled types model a native root tag.
    rootTag: rootTag as unknown as Parameters<typeof AppRegistry.runApplication>[1]["rootTag"],
  });
});
