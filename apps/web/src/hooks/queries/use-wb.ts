import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useTRPC } from "@/lib/trpc"

/**
 * 错词本查询 hooks。
 *
 * `wb.list` 用 due/active/all/mastered 四档控制范围，默认是 `due`
 * —— 打开错词本就该只看到"今天该练的"，已经会了的别再来占位置。
 * Practice 路由要的是"曾经错过"的全集（做填空加权），所以用 `active`。
 */

/** 当前用户的错词。默认只取到期的。 */
export function useWrongWords(
  scope: "due" | "active" | "all" | "mastered" = "due",
) {
  const trpc = useTRPC()
  return useQuery(trpc.wb.list.queryOptions({ scope }))
}

export function useWbStats() {
  const trpc = useTRPC()
  return useQuery(trpc.wb.stats.queryOptions())
}

/** 单条标「会了」或撤销。 */
export function useMarkWrongWord() {
  const trpc = useTRPC()
  const qc = useQueryClient()
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.wb.list.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.wb.stats.queryKey() }),
    ])
  return useMutation(
    trpc.wb.mark.mutationOptions({
      onSuccess: refresh,
    }),
  )
}

/**
 * 复习打点。Drill 里每答一个词调一次：答对把 due 往后推，答错明天再来。
 *
 * ⚠️ 这里**故意不 invalidate**：Drill 一次会话要连着打十几个词，每打一个
 * 都 refetch 一次列表（Neon 在新加坡，1.2s 一趟）会明显卡；而且列表收缩
 * 会和 Drill 自己的推进状态打架（踩过跳词）。Drill 靠本地 `done` 集合推进，
 * 退出时统一失效一次即可（见 wb.tsx 的 `onLeave`）。
 */
export function useGradeWrongWord() {
  const trpc = useTRPC()
  return useMutation(trpc.wb.grade.mutationOptions())
}

/** 退出 Drill 时统一刷新列表 / 统计。 */
export function useRefreshWb() {
  const trpc = useTRPC()
  const qc = useQueryClient()
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.wb.list.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.wb.stats.queryKey() }),
    ])
}

/** 单条删除（罕见；wb 路由里的「不需要这条」按钮）。 */
export function useRemoveWrongWord() {
  const trpc = useTRPC()
  const qc = useQueryClient()
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.wb.list.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.wb.stats.queryKey() }),
    ])
  return useMutation(
    trpc.wb.remove.mutationOptions({
      onSuccess: refresh,
    }),
  )
}

/** 把某一课的错词条目全清（清空按钮；非删课场景）。 */
export function useClearLessonWb() {
  const trpc = useTRPC()
  const qc = useQueryClient()
  return useMutation(
    trpc.wb.clearLesson.mutationOptions({
      onSuccess: async () =>
        Promise.all([
          qc.invalidateQueries({ queryKey: trpc.wb.list.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.wb.stats.queryKey() }),
        ]),
    }),
  )
}
