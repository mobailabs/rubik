import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * 注册已关（服务端同时收口，见 apps/api/src/auth/policy.ts 的 isSignUpPath）。
 *
 * 这里只是不让页面显示出来 —— 真正的边界在服务端 hooks.before，
 * 直接 POST /api/auth/sign-up/email 一样被拒。要临时开：ALLOW_SIGNUP="true"。
 */
export const Route = createFileRoute("/sign-up")({
  beforeLoad: () => {
    throw redirect({ to: "/sign-in" })
  },
})
