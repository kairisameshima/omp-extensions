# omp extensions

A CodeBuild watcher for [oh-my-pi](https://github.com/can1357/oh-my-pi). It shows the build status, current phase, elapsed time, and latest eight CloudWatch log lines in a panel above the editor. Watches run in the background, so you and the agent can keep working.

## Install

Requires omp (verified with 18.13.3), Git, and the AWS CLI on your `PATH`.

```sh
omp plugin install github:kairisameshima/omp-extensions
```

Restart omp after installing. The package registers the `/cbwatch` command and the `codebuild_watch` tool. No separate npm install or build step is needed. omp provides the extension's `@oh-my-pi/pi-tui` import.

If you already have a standalone `codebuild-watch.ts` in `~/.omp/agent/extensions/` or a project's `.omp/extensions/`, move it outside the extensions directory before restarting to avoid duplicate registrations.

To try a local checkout instead:

```sh
git clone https://github.com/kairisameshima/omp-extensions.git
omp plugin link ./omp-extensions
```

To update or remove the installed package:

```sh
omp plugin upgrade @kairisameshima/omp-extensions
omp plugin uninstall @kairisameshima/omp-extensions
```

Linked checkouts use local source changes directly and do not support `plugin upgrade`.

## AWS access

The watcher uses your AWS CLI credentials and region configuration, including environment variables such as `AWS_PROFILE` and `AWS_REGION`. Unlike the original local extension, it does not default to the `shared` profile or `us-east-1`. Pass `--profile` and `--region` to override your configuration for a watch.

For SSO profiles, authenticate first:

```sh
aws sso login --profile engineering
```

Your identity needs `codebuild:BatchGetBuilds` and `logs:GetLogEvents` for the watched build and its CloudWatch log stream. Watching by project also requires `codebuild:ListBuildsForProject`. The watcher only reads AWS resources.

## Usage

Watch a specific build:

```text
/cbwatch my-project:00000000-0000-0000-0000-000000000000
```

Watch a project's newest build:

```text
/cbwatch my-project --profile engineering --region us-west-2
```

Wait for a build matching a commit SHA prefix:

```text
/cbwatch my-project abc1234 --profile engineering --region us-west-2
```

You can also ask the agent to watch a build. Its `codebuild_watch` tool accepts `build_id`, or `project` with an optional `source_version` SHA prefix, plus optional `profile` and `region` overrides.

## Behavior and limits

The watcher polls every five seconds and stops watching after two hours. Project watches search the ten newest builds. A commit watch keeps polling until a matching build appears. Distinct build IDs or project/SHA targets can be watched together. Avoid starting the same target twice, including in different accounts or regions, because its panel key does not include the AWS profile or region.

When a build ends, the panel is removed and a result message reports its status and any failed phase. An agent-started watch wakes the idle agent. A `/cbwatch` watch displays the result without starting an idle agent turn. Final messages do not include the log tail.

AWS errors appear in the panel, and polling continues so refreshing expired credentials can resume the watch. CloudWatch logs must be enabled on the build to display log output. Watches belong to the current omp session and do not survive restarting omp.
