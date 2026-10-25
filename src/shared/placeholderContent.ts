/**
 * 三个待开发模块的说明卡内容（PRD §2.2）
 *
 * 要求：写清"这个模块是干什么的"以及"计划中的核心功能"，
 * 让点击的人知道这块以后长什么样，而不是撞一堵墙。
 */

export interface PlaceholderFeature {
  title: string
  detail: string
}

export interface PlaceholderContent {
  summary: string
  features: PlaceholderFeature[]
}

export const PLACEHOLDER_CONTENT: Record<'project' | 'research' | 'ledger', PlaceholderContent> = {
  project: {
    summary: '一件有多步骤的事：分阶段推进，能看到卡在哪、什么时候能做完。',
    features: [
      { title: '阶段划分', detail: '把项目拆成几个阶段，每个阶段有明确的完成条件' },
      { title: '进度推进', detail: '阶段内勾选步骤，整体进度自动汇总' },
      { title: '卡点记录', detail: '当前卡在什么地方、等谁、等什么，一眼看到' },
      { title: '完成日期', detail: '计划完成时间与实际完成时间对照' }
    ]
  },
  research: {
    summary: '为了做决定而调研：有哪些方案、各自优缺点、最后选了哪个、为什么。',
    features: [
      { title: '方案对比', detail: '把候选方案并排放在一起，逐维度打分' },
      { title: '优缺点记录', detail: '每个方案的好处与代价分开写清楚' },
      { title: '资料收集', detail: '调研过程中看过的文章、文档、链接集中存放' },
      { title: '结论归档', detail: '最终选了哪个、当时的理由是什么，日后可回查' }
    ]
  },
  ledger: {
    summary: '花钱的记录：记了什么、花在哪一类、一个月一共多少。',
    features: [
      { title: '收支记录', detail: '金额、日期、分类、备注' },
      { title: '分类管理', detail: '按自己的习惯定义分类，不预设一套用不上的科目' },
      { title: '月度合计', detail: '每月各类支出汇总，与上月对比' },
      { title: '快速记账', detail: '一个输入框敲完金额与分类，回车即存' }
    ]
  }
}
