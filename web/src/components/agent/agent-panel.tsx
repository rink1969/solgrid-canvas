import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { motion } from "motion/react";
import { Move } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AcpAgentPanel } from "./acp-agent-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { CANVAS_AGENT_PANEL_MOTION_MS, useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";

const PANEL_MOTION_SECONDS = CANVAS_AGENT_PANEL_MOTION_MS / 1000;
const POSITION_KEY = "canvas-agent-panel-pos";
const HEIGHT_KEY = "canvas-agent-panel-height";

function defaultFloatingHeight() {
    return Math.min(720, Math.max(360, window.innerHeight - 48));
}

function clampPosition(x: number, y: number, width: number, height = defaultFloatingHeight()) {
    return {
        x: Math.max(8, Math.min(x, window.innerWidth - Math.min(width + 1, window.innerWidth - 16) - 8)),
        y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    };
}

export function AgentPanel() {
    const { t } = useTranslation();
    useEffect(() => {
        useAgentStore.getState().setAgentState({ panelMounted: true });
    }, []);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const width = useAgentStore((state) => state.width);
    const [resizing, setResizing] = useState(false);
    const [floating, setFloating] = useState(() => localStorage.getItem("canvas-agent-panel-floating") === "1");
    const [floatingHeight, setFloatingHeight] = useState(() => {
        const saved = Number(localStorage.getItem(HEIGHT_KEY));
        return Number.isFinite(saved) && saved >= 360 ? Math.min(720, saved) : defaultFloatingHeight();
    });
    const [floatingPos, setFloatingPos] = useState(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(POSITION_KEY) || "null") as { x?: number; y?: number } | null;
            if (typeof saved?.x === "number" && typeof saved?.y === "number") return clampPosition(saved.x, saved.y, width, floatingHeight);
        } catch {
            /* 忽略损坏的本地位置 */
        }
        return clampPosition(window.innerWidth - width - 24, 24, width, floatingHeight);
    });
    const toggleFloating = () => {
        setFloating((current) => {
            const next = !current;
            localStorage.setItem("canvas-agent-panel-floating", next ? "1" : "0");
            return next;
        });
    };
    useEffect(() => {
        if (!floating) return;
        setFloatingPos((current) => clampPosition(current.x, current.y, width, floatingHeight));
    }, [floating, width, floatingHeight]);
    const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!floating) return;
        event.preventDefault();
        const startX = event.clientX;
        const startY = event.clientY;
        const base = { ...floatingPos };
        let last = base;
        const onMove = (moveEvent: PointerEvent) => {
            last = clampPosition(base.x + moveEvent.clientX - startX, base.y + moveEvent.clientY - startY, width, floatingHeight);
            setFloatingPos(last);
        };
        const onUp = () => {
            localStorage.setItem(POSITION_KEY, JSON.stringify(last));
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };
    const startHeightResize = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!floating) return;
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = floatingHeight;
        let nextHeight = startHeight;
        const onMove = (moveEvent: PointerEvent) => {
            nextHeight = Math.min(720, Math.max(360, startHeight + moveEvent.clientY - startY));
            setFloatingHeight(nextHeight);
        };
        const onUp = () => {
            localStorage.setItem(HEIGHT_KEY, String(nextHeight));
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const panelClosing = useAgentStore((state) => state.panelClosing);
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        let nextWidth = startWidth;
        const onMove = (moveEvent: PointerEvent) => {
            nextWidth = Math.min(760, Math.max(360, startWidth + startX - moveEvent.clientX));
            setAgentState({ width: nextWidth });
        };
        const onUp = () => {
            localStorage.setItem("canvas-agent-panel-width", String(nextWidth));
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            setResizing(false);
        };
        setResizing(true);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    return (
        <motion.div
            className={floating ? "fixed z-[80] flex h-auto flex-col" : "relative z-[70] flex h-full shrink-0"}
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: panelOpen ? width + 1 : 0, opacity: panelOpen ? 1 : 0 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{
                overflow: floating ? "visible" : "clip",
                pointerEvents: panelOpen && !panelClosing ? undefined : "none",
                ...(floating ? { left: floatingPos.x, top: floatingPos.y, height: floatingHeight } : null),
            }}
        >
            <motion.aside
                className={`relative flex h-full min-h-0 shrink-0 flex-col ${floating ? "rounded-xl border shadow-2xl" : "border-l"}`}
                data-canvas-shortcuts-ignore
                initial={{ x: 48 }}
                animate={{ x: panelClosing ? 28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
                style={{ width, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            >
                {floating ? (
                    <div
                        className="absolute left-1/2 top-0 z-50 flex h-5 w-12 -translate-x-1/2 cursor-move items-center justify-center rounded-bl-md opacity-50 hover:opacity-90"
                        onPointerDown={startDrag}
                        title="拖动窗口"
                    >
                        <Move className="size-3" />
                    </div>
                ) : null}
                <button type="button" className="absolute inset-y-8 left-0 z-40 w-1.5 -translate-x-1/2 cursor-col-resize rounded-full bg-stone-400/20 hover:bg-stone-400/50" onPointerDown={startResize} aria-label={t("agent.panel.resize")} />
                {floating ? <div className="absolute bottom-0 right-0 z-50 size-3 cursor-nwse-resize rounded-tl-md bg-stone-400/20 hover:bg-stone-400/50" onPointerDown={startHeightResize} title="调整窗口大小" /> : null}
                <AcpAgentPanel floating={floating} onToggleFloating={toggleFloating} />
            </motion.aside>
        </motion.div>
    );
}
