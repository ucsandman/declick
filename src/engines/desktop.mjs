export async function compile() { throw Object.assign(new Error('desktop engine arrives in Task 8'), { exit: 4 }); }
export async function execute() { return { ok: false, exit: 4, error: 'desktop engine arrives in Task 8' }; }
