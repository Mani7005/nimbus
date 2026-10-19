import { useState } from "react";
import AuthCard from "../components/AuthCard";
import AuthInput from "../components/AuthInput";
import { getApiErrorMessage } from "../services/api-errors";
import { register } from "../services/auth";
import { saveToken } from "../utils/storage";

interface RegisterProps {
  onRegister: () => void;
  goToLogin: () => void;
}

function Register({ onRegister, goToLogin }: RegisterProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleRegister() {
    if (password !== confirmPassword) {
      alert("Passwords do not match");
      return;
    }

    try {
      setLoading(true);
      const data = await register(email, password);
      saveToken(data.token);
      onRegister();
    } catch (error) {
      alert(getApiErrorMessage(error, "Registration failed. Please try again."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard subtitle="Create your account">
      <AuthInput className="mb-4" placeholder="Full Name" value={name} onChange={(event) => setName(event.target.value)} />
      <AuthInput className="mb-4" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
      <AuthInput type="password" className="mb-4" placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} />
      <AuthInput type="password" className="mb-6" placeholder="Confirm Password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
      <button onClick={handleRegister} className="w-full bg-blue-600 hover:bg-blue-700 p-3 rounded text-white">{loading ? "Creating..." : "Register"}</button>
      <p className="text-zinc-400 mt-5 text-center">Already have an account? <button onClick={goToLogin} className="text-blue-400">Login</button></p>
    </AuthCard>
  );
}

export default Register;
