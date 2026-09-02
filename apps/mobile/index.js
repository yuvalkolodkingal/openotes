// crypto.getRandomValues, which the sync engine and the key derivation both
// need, is not part of the React Native runtime; this polyfill has to be the
// first import so everything after it finds it.
import "react-native-get-random-values";
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
