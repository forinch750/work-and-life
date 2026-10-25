/**
 * 偏好的读写小工具（第 08 块抽出来给 `App.tsx` 用）
 *
 * 为什么单独一份：侧栏收起（决定 6）是**全局外壳**的状态，不是某个页面自己的事。
 * `SettingsPage` 早就有一套"没有记录就新建、有就合并更新"的写法，这里把同一套
 * 逻辑抄成公共函数，避免外壳再写一遍、两边行为慢慢分叉。
 *
 * 与 `SettingsPage.savePrefs` 的差别：这里只写**一个字段**，不经过
 * `normalizePreferences` 的"只保留 true"过滤——收起/展开要能双向写，
 * 展开时必须真的把 `false` 落库，否则"收起一次以后再点也回不去"。
 */
import {
  PREFERENCES_ID,
  PREFERENCES_MODULE,
  isSidebarCollapsed,
  normalizeHiddenTopicIds,
  readPreferences,
  type AppPreferences
} from '../../shared/preferences'
import { getDataApi } from './dataClient'
import { notifyDataChanged } from './dataEvents'

/** 从磁盘读整份偏好（读不到就返回默认值，不抛错） */
export async function loadPreferences(): Promise<AppPreferences> {
  const records = (await getDataApi().list(PREFERENCES_MODULE)) as unknown as Array<
    Record<string, unknown>
  >
  return readPreferences(records)
}

/**
 * 把"复习页隐藏了哪些主题"写进偏好并落盘（修改 2 轮）。
 *
 * 与 `saveSidebarCollapsed` 同一个套路：**只写这一个字段**、写盘、广播、读回来核对。
 * 传空数组就是"没有任何隐藏"（照样显式写 `[]`，否则删不掉上一次的值）。
 *
 * ⚠️ 这个字段**只影响左栏显示**：任何"算总数 / 算角标"的地方都不许读它
 * （`MASTER.md` 决定 19 / R1：隐藏不得造成漏复习）。
 */
export async function saveReviewHiddenTopicIds(ids: string[]): Promise<string[]> {
  const api = getDataApi()
  const records = (await api.list(PREFERENCES_MODULE)) as unknown as Array<Record<string, unknown>>
  const existing = records.find((record) => record['id'] === PREFERENCES_ID)
  // 清洗一遍再写：宁可存进去的是干净数据，也不要靠读的时候兜底
  const value = normalizeHiddenTopicIds(ids) ?? []
  if (existing) {
    await api.update(PREFERENCES_MODULE, PREFERENCES_ID, { reviewHiddenTopicIds: value })
  } else {
    await api.add(PREFERENCES_MODULE, { id: PREFERENCES_ID, reviewHiddenTopicIds: value })
  }
  // 偏好"改完就应当立即保存"，不等防抖窗口
  await api.flush()
  notifyDataChanged('app')
  const reloaded = await loadPreferences()
  return reloaded.reviewHiddenTopicIds ?? []
}

/**
 * 把"侧栏收起"写进偏好并落盘。
 *
 * 返回落库后的值（读回来核对一遍，避免界面与磁盘不一致）：
 * 界面上的状态与磁盘上的状态必须是同一个数，否则重启后会「莫名其妙弹开/收起」。
 */
export async function saveSidebarCollapsed(collapsed: boolean): Promise<boolean> {
  const api = getDataApi()
  const records = (await api.list(PREFERENCES_MODULE)) as unknown as Array<Record<string, unknown>>
  const existing = records.find((record) => record['id'] === PREFERENCES_ID)
  if (existing) {
    await api.update(PREFERENCES_MODULE, PREFERENCES_ID, { sidebarCollapsed: collapsed })
  } else {
    await api.add(PREFERENCES_MODULE, { id: PREFERENCES_ID, sidebarCollapsed: collapsed })
  }
  // 偏好"设置完就应当立即保存"，不等防抖窗口
  await api.flush()
  // 广播出去：别的读偏好的地方（设置页）能跟着刷
  notifyDataChanged('app')
  const reloaded = await loadPreferences()
  return isSidebarCollapsed(reloaded)
}

/**
 * 把"逾期提醒被关掉的那一天"（`overdueHintDismissedOn`）写进偏好并落盘（修改 6 轮）。
 *
 * 只写**这一天**：第二天日期一变，`shouldShowOverdueHint` 的 `!== 今天` 自然就不成立，
 * 提示会自动回来——不需要在磁盘上做什么"过期清理"。
 *
 * 与其它偏好写入同一套路：只写一个字段、立即 flush、广播、读回来核对。
 * 返回值是落库后真正生效的日期（读不到就是 undefined = 没关过）。
 */
export async function saveOverdueHintDismissedOn(dayKey: string): Promise<string | undefined> {
  const api = getDataApi()
  const records = (await api.list(PREFERENCES_MODULE)) as unknown as Array<Record<string, unknown>>
  const existing = records.find((record) => record['id'] === PREFERENCES_ID)
  if (existing) {
    await api.update(PREFERENCES_MODULE, PREFERENCES_ID, { overdueHintDismissedOn: dayKey })
  } else {
    await api.add(PREFERENCES_MODULE, { id: PREFERENCES_ID, overdueHintDismissedOn: dayKey })
  }
  // 偏好"改完就应当立即保存"，不等防抖窗口（重开程序也不再弹，就靠这一下）
  await api.flush()
  notifyDataChanged('app')
  const reloaded = await loadPreferences()
  return reloaded.overdueHintDismissedOn
}
