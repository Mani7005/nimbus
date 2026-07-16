interface NavbarProps {
  onRun: () => void;
}

function Navbar({ onRun }: NavbarProps) {
  return (
    <header className="h-16 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between px-6">

      <h1 className="text-2xl font-bold text-white">
        Nimbus
      </h1>

      <div className="flex items-center gap-4">

        <select className="bg-zinc-800 text-white px-3 py-2 rounded-lg">
          <option value="cpp">C++</option>
        </select>

        <button
          onClick={onRun}
          className="bg-blue-600 hover:bg-blue-700 px-5 py-2 rounded-lg text-white font-semibold"
        >
          ▶ Run
        </button>

      </div>

    </header>
  );
}

export default Navbar;