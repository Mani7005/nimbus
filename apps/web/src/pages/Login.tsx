import { useState } from "react";
import AuthCard from "../components/AuthCard";
import { login } from "../services/auth";
import { saveToken } from "../utils/storage";

interface LoginProps {
  onLogin: () => void;
  goToRegister: () => void;
}

function Login({ onLogin, goToRegister }: LoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    try {
      setLoading(true);
      const data = await login(email, password);
      saveToken(data.token);
      onLogin();
    } catch {
      alert("Invalid Email or Password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard subtitle="Secure Online IDE">
      <input className="w-full p-3 mb-4 rounded bg-zinc-800 text-white" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
      <input type="password" className="w-full p-3 mb-6 rounded bg-zinc-800 text-white" placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} />
      <button onClick={handleLogin} className="w-full bg-blue-600 hover:bg-blue-700 p-3 rounded text-white">{loading ? "Signing In..." : "Login"}</button>
      <p className="text-zinc-400 mt-5 text-center">Don't have an account? <button onClick={goToRegister} className="text-blue-400">Register</button></p>
    </AuthCard>
  );
}

export default Login;
