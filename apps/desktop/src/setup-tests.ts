import "@testing-library/jest-dom/vitest";

localStorage.setItem("massion.language.v1", "ko");

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);
