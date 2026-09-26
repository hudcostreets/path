from json import dumps, loads
from urllib.request import Request, urlopen

from click import Choice, argument, option
from thrds import SlackClient, Thread
from utz import err

from path_data.cli.base import path_data

BOT_USERNAME = 'PATH Data'
SITE_URL = 'https://pa.hccs.dev'


def get_client(token: str, channel: str) -> SlackClient:
    return SlackClient(
        token=token,
        channel=channel,
        username=BOT_USERNAME,
        icon_emoji=NO_DATA_EMOJI,
    )


NO_DATA_EMOJI = ':hourglass_flowing_sand:'


def post_message(
    text: str,
    channel: str,
    token: str,
    username: str | None = None,
    icon_emoji: str | None = None,
    thread_ts: str | None = None,
    blocks: list | None = None,
):
    """Post a message to Slack via the Bot API. Pass `thread_ts` to reply
    in an existing thread (use the `ts` of the parent message). Pass `blocks`
    to render Block Kit rich content — `text` then acts as the notification
    fallback but is not displayed."""
    payload = dict(channel=channel, text=text)
    if blocks:
        payload['blocks'] = blocks
    if username:
        payload['username'] = username
    if icon_emoji:
        payload['icon_emoji'] = icon_emoji
    if thread_ts:
        payload['thread_ts'] = thread_ts

    data = dumps(payload).encode()
    req = Request(
        'https://slack.com/api/chat.postMessage',
        data=data,
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
        },
    )
    with urlopen(req) as resp:
        body = resp.read().decode()

    result = loads(body)
    if not result.get('ok'):
        raise RuntimeError(f"Slack API error: {result.get('error', body)}")
    return result


def latest_bot_message(
    client: SlackClient,
    username: str = BOT_USERNAME,
    limit: int = 20,
) -> dict | None:
    """Return the most recent top-level message posted by our bot."""
    result = client._request("conversations.history", {
        "channel": client.channel,
        "limit": limit,
    }, method="GET")
    for msg in result.get('messages', []):
        if msg.get('username') == username:
            return msg
    return None


@path_data.command('slack')
@option('-c', '--channel', envvar='SLACK_CHANNEL_ID', required=True, help='Slack channel ID')
@option('-e', '--icon-emoji', default=':train:', help='Bot icon emoji')
@option('-t', '--token', envvar='SLACK_BOT_TOKEN', required=True, help='Slack bot token')
@option('-u', '--username', default='PATH Data', help='Bot display name')
@argument('message')
def slack(channel: str, icon_emoji: str, token: str, username: str, message: str):
    """Post a notification to Slack."""
    result = post_message(
        text=message,
        channel=channel,
        token=token,
        username=username,
        icon_emoji=icon_emoji,
    )
    err(f"Posted to #{channel}: ts={result.get('ts')}")


def deploy_message(
    status: str,
    summary: str,
    data_run_url: str | None,
    deploy_run_url: str | None,
    site_path: str,
) -> tuple[str, str]:
    """Return `(text, icon_emoji)` announcing new data once its deploy has finished."""
    data_link = f'<{data_run_url}|View data run>' if data_run_url else None
    deploy_link = f'<{deploy_run_url}|View deploy run>' if deploy_run_url else None
    if status == 'success':
        links = [data_link, deploy_link, f'<{SITE_URL}{site_path}|View site>']
        text = f":white_check_mark: *New data:* {summary} — published and deployed"
        emoji = ':white_check_mark:'
    else:
        links = [deploy_link, data_link]
        text = f":rotating_light: *Deploy failed:* {summary} is published, but not live"
        emoji = ':rotating_light:'
    return text + '\n' + ' · '.join(link for link in links if link), emoji


@path_data.command('deploy-notify')
@option('-c', '--channel', envvar='SLACK_CHANNEL_ID', required=True, help='Slack channel ID')
@option('-d', '--data-run-url', help='URL of the data-update GHA run that published the new data')
@option('-p', '--site-path', default='/', help='Site path to link, e.g. `/bt`')
@option('-r', '--deploy-run-url', help='URL of the deploy GHA run')
@option('-s', '--status', type=Choice(['success', 'failure']), required=True, help='Deploy outcome')
@option('-t', '--token', envvar='SLACK_BOT_TOKEN', required=True, help='Slack bot token')
@argument('summary')
def deploy_notify(
    channel: str,
    data_run_url: str | None,
    site_path: str,
    deploy_run_url: str | None,
    status: str,
    token: str,
    summary: str,
):
    """Announce new data after its `www.yml` deploy finishes (success or failure).

    `SUMMARY` is e.g. "B&T through Jul '26 (was Jun '26)". Posted from the deploy
    workflow so "deployed" is only claimed once it's true."""
    text, emoji = deploy_message(status, summary, data_run_url, deploy_run_url, site_path)
    result = post_message(
        text=text,
        channel=channel,
        token=token,
        username=BOT_USERNAME,
        icon_emoji=emoji,
    )
    err(f"Posted to #{channel}: ts={result.get('ts')}")
