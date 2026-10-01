import { Toast } from "@base-ui/react/toast";
import { Tooltip } from "@base-ui/react/tooltip";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { applyTheme, storedTheme } from "./lib/theme.ts";
import { router } from "./router.tsx";
import "./styles/app.css";

applyTheme(storedTheme());

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <Tooltip.Provider delay={400}>
      <Toast.Provider timeout={3000}>
        <RouterProvider router={router} />
      </Toast.Provider>
    </Tooltip.Provider>
  </StrictMode>,
);
