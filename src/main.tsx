import { AppRegistry } from "react-native";
import App from "./App";
import "./global.css";

const rootTag = document.getElementById("root");

if (!rootTag) {
  throw new Error("Nomi root element was not found");
}

AppRegistry.registerComponent("Nomi", () => App);
AppRegistry.runApplication("Nomi", {
  initialProps: {},
  // Runtime is react-native-web; React Native's bundled types model a native root tag.
  rootTag: rootTag as unknown as Parameters<typeof AppRegistry.runApplication>[1]["rootTag"],
});
