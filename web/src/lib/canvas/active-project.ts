// 当前正在编辑的画布项目 id：资产上传时决定落到哪个 projects/<id>/assets/。
// 由画布编辑页设置；不在项目内时（素材库等工作台）落到 _inbox，属于临时归置。
const INBOX = "_inbox";

let activeProjectId = INBOX;

export function setActiveProjectId(id?: string | null) {
    activeProjectId = id || INBOX;
}

export function getActiveProjectId() {
    return activeProjectId;
}
