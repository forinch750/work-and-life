/**
 * 树的调试挂点（第二轮 FEAT-006，供 `src\main\verify\phase8.ts` 用）
 *
 * ## 为什么需要它
 *
 * "跨 owner 移动必须被拒绝"这条**在界面上做不出来**：页面只渲染当前这棵树，
 * 用户不可能把一本书的章节拖到另一本书上。但这条判据又必须在**真实运行的程序里**
 * 验一遍（不能只靠单测说"代码里拦了"）。
 *
 * 所以这里把**当前页那棵树的真实移动函数**挂到 `window.__worklifeTree` 上，
 * 验收可以拿一个**别的 owner 的节点 id** 调一次，看它是不是真的被拒、
 * 以及数据有没有被改动。挂上去的是页面自己的闭包，走的是与拖拽完全相同的那条路。
 *
 * ## 边界
 *
 * - 只暴露三个纯函数式操作，参数与返回值都是普通 JSON（不含任何内部对象的引用）
 * - 页面卸载时**必须摘掉**，避免留下过期的闭包
 * - 不是给界面用的：界面上的移动一律走拖动或右键菜单
 */
import { useEffect, useRef } from 'react'
import type { TreeViewItem } from '../../shared/treeView'
import type { TreeLike } from '../../shared/treeMove'

export interface TreeDebugApi {
  /** 当前页这棵树的归属（学习主题 id / 书 id） */
  ownerId: string
  /** 当前这一屏渲染出来的节点 id（诊断用：确认挂点与界面是不是同一棵树） */
  nodeIds: () => string[]
  /**
   * 重新从存储里读一遍**全量**存活节点 id。
   *
   * 为什么需要：`nodeIds()` 给的是**当前这一屏渲染的那些**，
   * 而验收要验的正是"拿一个**别的** owner 的节点 id 来移动"——
   * 那个 id 天然不在这一屏里。要复核"跨 owner 被拒"是真的判了 owner
   * （而不是"压根没这个节点"），就得把存储里的全量 id 拿出来。
   */
  freshNodeIds: (module: 'learning' | 'reading') => Promise<string[]>
  /** 跨 owner / 成环判据（纯逻辑，与拖拽共用同一份实现） */
  canMove: (dragId: string, parentId: string | null) => { ok: boolean; reason: string | null }
  /** 真的走一次移动：返回失败原因；成功返回 null 并已写盘 */
  tryMove: (
    dragId: string,
    parentId: string | null,
    index: number
  ) => Promise<string | null>
}

export interface TreeDebugInput {
  ownerId: string
  items: TreeViewItem[]
  canMove: (dragId: string, parentId: string | null) => { ok: boolean; reason: string | null }
  tryMove: (dragId: string, parentId: string | null, index: number) => Promise<string | null>
  /** 由页面提供：读该模块**全量**存活节点的 id（含别的 owner 的） */
  loadNodeIds: (module: 'learning' | 'reading') => Promise<string[]>
}

declare global {
  interface Window {
    __worklifeTree?: TreeDebugApi
  }
}

/** 把当前页的树挂到 `window.__worklifeTree`；卸载时自动摘掉 */
export function useTreeDebug(input: TreeDebugInput): void {
  // 每次渲染都刷新最新值，但只有 ownerId 变了才重挂——
  // 否则每渲染一次就重挂一次，验收取到的闭包会在半路被换掉
  const latest = useRef(input)
  latest.current = input

  useEffect(() => {
    const api: TreeDebugApi = {
      ownerId: input.ownerId,
      nodeIds: () => latest.current.items.map((item) => item.id),
      freshNodeIds: (module) => latest.current.loadNodeIds(module),
      canMove: (dragId, parentId) => latest.current.canMove(dragId, parentId),
      tryMove: (dragId, parentId, index) => latest.current.tryMove(dragId, parentId, index)
    }
    window.__worklifeTree = api
    return () => {
      if (window.__worklifeTree === api) delete window.__worklifeTree
    }
  }, [input.ownerId])
}

/** 供验收直接调用 `canMove` 的纯逻辑（形状与 `treeMove.ts` 一致） */
export type { TreeLike }