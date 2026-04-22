import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { AuthProvider, useAuth } from "@/lib/auth-context"
import LoginPage from "@/pages/LoginPage"
import RegisterPage from "@/pages/RegisterPage"
import ChatPage from "@/pages/ChatPage"
import SetupPage from "@/pages/SetupPage"
import AdminPage from "@/pages/AdminPage"

function Loading() {
  return (
    <div className="grid min-h-svh place-items-center text-muted-foreground">
      加载中…
    </div>
  )
}

function Protected({ children }: { children: React.ReactNode }) {
  const { state } = useAuth()
  if (state.status === "loading") return <Loading />
  if (state.status === "setup") return <Navigate to="/setup" replace />
  if (state.status === "anon") return <Navigate to="/login" replace />
  return <>{children}</>
}

function AnonOnly({ children }: { children: React.ReactNode }) {
  const { state } = useAuth()
  if (state.status === "loading") return <Loading />
  if (state.status === "setup") return <Navigate to="/setup" replace />
  if (state.status === "authed") return <Navigate to="/" replace />
  return <>{children}</>
}

function SetupOnly({ children }: { children: React.ReactNode }) {
  const { state } = useAuth()
  if (state.status === "loading") return <Loading />
  if (state.status !== "setup") return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route
            path="/setup"
            element={
              <SetupOnly>
                <SetupPage />
              </SetupOnly>
            }
          />
          <Route
            path="/login"
            element={
              <AnonOnly>
                <LoginPage />
              </AnonOnly>
            }
          />
          <Route
            path="/register"
            element={
              <AnonOnly>
                <RegisterPage />
              </AnonOnly>
            }
          />
          <Route
            path="/"
            element={
              <Protected>
                <ChatPage />
              </Protected>
            }
          />
          <Route
            path="/c/:id"
            element={
              <Protected>
                <ChatPage />
              </Protected>
            }
          />
          <Route
            path="/admin"
            element={
              <Protected>
                <AdminPage />
              </Protected>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
