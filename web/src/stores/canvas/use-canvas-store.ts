import { create } from "zustand";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type CanvasDeletedProject = {
    id: string;
    deletedAt: string;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    deletedProjects: CanvasDeletedProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>, id?: string) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[], deletedProjects?: CanvasDeletedProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };

// 画布项目不再落地浏览器：daemon 的项目目录是唯一事实源，
// 这里只保留内存镜像，由 lib/canvas/project-sync.ts 负责双向同步。
export const useCanvasStore = create<CanvasStore>()((set, get) => ({
    hydrated: false,
    projects: [],
    deletedProjects: [],
    createProject: (title = i18n.t("canvas.project.untitled")) => {
        const now = new Date().toISOString();
        const id = nanoid();
        const project: CanvasProject = {
            id,
            title,
            createdAt: now,
            updatedAt: now,
            nodes: [],
            connections: [],
            chatSessions: [],
            activeChatId: null,
            backgroundMode: "lines",
            showImageInfo: false,
            viewport: initialViewport,
        };
        set((state) => ({ projects: [project, ...state.projects] }));
        return id;
    },
    importProject: (source, id) => {
        const now = new Date().toISOString();
        const project: CanvasProject = {
            id: id || nanoid(),
            title: source.title || i18n.t("canvas.project.imported"),
            createdAt: source.createdAt || now,
            updatedAt: now,
            nodes: source.nodes || [],
            connections: source.connections || [],
            chatSessions: source.chatSessions || [],
            activeChatId: source.activeChatId || null,
            backgroundMode: source.backgroundMode || "lines",
            showImageInfo: source.showImageInfo || false,
            viewport: source.viewport || initialViewport,
        };
        set((state) => ({ projects: [project, ...state.projects] }));
        return project.id;
    },
    openProject: (id) => {
        return get().projects.find((item) => item.id === id) || null;
    },
    renameProject: (id, title) =>
        set((state) => ({
            projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
        })),
    deleteProjects: (ids) =>
        set((state) => {
            const now = new Date().toISOString();
            const removing = new Set(ids);
            const projects = state.projects.filter((project) => !removing.has(project.id));
            const deletedProjects = [...state.deletedProjects.filter((item) => !removing.has(item.id)), ...ids.map((id) => ({ id, deletedAt: now }))];
            return { projects, deletedProjects };
        }),
    replaceProjects: (projects, deletedProjects = []) => set({ projects, deletedProjects }),
    updateProject: (id, patch) =>
        set((state) => ({
            projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),
        })),
}));
