from __future__ import annotations

import aiohttp
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.components.hassio import HassioServiceInfo
from homeassistant.data_entry_flow import FlowResult

from .const import CONF_TOKEN, CONF_URL, DOMAIN


class HestiaConversationConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_hassio(self, discovery_info: HassioServiceInfo) -> FlowResult:
        """Handle discovery from the HestiaClaw addon — zero user input needed."""
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured(updates={
            CONF_URL: discovery_info.config["url"],
            CONF_TOKEN: discovery_info.config.get("token", ""),
        })
        return self.async_create_entry(
            title="Hestia",
            data={
                CONF_URL: discovery_info.config["url"],
                CONF_TOKEN: discovery_info.config.get("token", ""),
            },
        )

    async def async_step_user(self, user_input=None) -> FlowResult:
        """Fallback manual setup for users not running the addon."""
        errors: dict[str, str] = {}

        if user_input is not None:
            await self.async_set_unique_id(DOMAIN)
            self._abort_if_unique_id_configured()

            url = user_input[CONF_URL].rstrip("/")
            token = user_input.get(CONF_TOKEN, "").strip()
            headers = {"Authorization": f"Bearer {token}"} if token else {}

            try:
                async with aiohttp.ClientSession() as sess:
                    async with sess.post(
                        f"{url}/api/ha-voice/process",
                        json={"text": "ping", "conversation_id": "ha-config-test"},
                        headers=headers,
                        timeout=aiohttp.ClientTimeout(total=10),
                    ) as resp:
                        if resp.status == 401:
                            errors["base"] = "invalid_auth"
                        elif resp.status >= 400:
                            errors["base"] = "cannot_connect"
                        else:
                            return self.async_create_entry(
                                title="Hestia",
                                data={CONF_URL: url, CONF_TOKEN: token},
                            )
            except Exception:  # noqa: BLE001
                errors["base"] = "cannot_connect"

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_URL, default="http://localhost:3001"): str,
                    vol.Optional(CONF_TOKEN, default=""): str,
                }
            ),
            errors=errors,
        )
