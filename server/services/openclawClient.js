function createOpenclawExec({ execFilePromise, bin, configPath, processEnv = process.env }) {
  return async function openclawExec(args, timeout = 10000) {
    const env = {
      ...processEnv,
      HOME: processEnv.HOME || '/home/ubuntu',
      USER: processEnv.USER || 'user',
      LOGNAME: processEnv.LOGNAME || processEnv.USER || 'user',
      LANG: processEnv.LANG || 'en_US.UTF-8',
      PATH: `/opt/homebrew/bin:/usr/local/bin:${processEnv.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`,
      OPENCLAW_CONFIG_PATH: configPath,
    };
    delete env.OPENCLAW_GATEWAY_TOKEN;
    delete env.OPENCLAW_GATEWAY_REMOTE_TOKEN;
    return execFilePromise(bin, args, {
      timeout,
      maxBuffer: 20 * 1024 * 1024,
      env,
    });
  };
}

module.exports = {
  createOpenclawExec,
};
