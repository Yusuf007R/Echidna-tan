import {
  AudioPlayer,
  AudioPlayerState,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnection,
} from '@discordjs/voice';
import {
  CacheType,
  CommandInteraction,
  GuildMember,
  MessageActionRow,
  MessageEmbed,
  MessageSelectMenu,
  SelectMenuInteraction,
} from 'discord.js';
import { isNullOrUndefined } from 'util';

import ytdl from 'ytdl-core';
import ytpl from 'ytpl';

import ytsr from 'ytsr';
import createYTStream from '../utils/create-yt-stream';
import secondsToMinutes from '../utils/seconds-to-minutes';

export default class MusicPlayer {
  private voiceConnection: VoiceConnection | null = null;

  private queue: (ytdl.videoInfo | string)[] = [];

  private audioPlayer: AudioPlayer | null = null;

  private currentInteration: CommandInteraction<CacheType> | null = null;

  private currentInfo: ytdl.videoInfo | null = null;

  constructor() {}

  async play(interaction: CommandInteraction<CacheType>) {
    const query = interaction.options.getString('query');
    this.currentInteration = interaction;
    if (!query) return interaction.editReply('No query provided');
    const trimedQuery = query.trim();
    if (ytdl.validateURL(trimedQuery) || ytdl.validateID(trimedQuery)) {
      try {
        const video = await ytdl.getInfo(trimedQuery);
        this.queue.push(video);
        interaction.editReply({ content: `${video.videoDetails.title} added to the queue.` });
        this._play();
      } catch (error) {
        this._internalErrorMessage(error);
      }
      return;
    }

    if (ytpl.validateID(trimedQuery)) {
      try {
        const playlist = await ytpl(trimedQuery, { limit: Infinity });
        this.queue.push(...playlist.items.map((item) => item.id));
        interaction.editReply({
          content: `${playlist.items.length} songs have been added to the Queue.`,
        });
        this._play();
      } catch (error) {
        this._internalErrorMessage(error);
      }
      return;
    }
    await this.youtubeSearch(interaction, trimedQuery);
  }

  pause(interaction: CommandInteraction<CacheType>) {
    if (!this.audioPlayer) return interaction.editReply('No music is playing.');
    if (this.audioPlayer.state.status === AudioPlayerStatus.Paused) return interaction.editReply('music is already paused.');
    interaction.editReply('Music paused.');
    this.audioPlayer?.pause();
  }

  resume(interaction: CommandInteraction<CacheType>) {
    if (!this.audioPlayer) return interaction.editReply('No music is playing.');
    if (this.audioPlayer?.state.status === AudioPlayerStatus.Playing) return interaction.editReply('Music is already playing.');
    interaction.editReply('Music resumed.');
    this.audioPlayer?.unpause();
  }

  skip(interaction: CommandInteraction<CacheType>) {
    if (!this.audioPlayer) return interaction.editReply('No music is playing.');
    if (this.queue.length <= 1) return interaction.editReply('No more songs in the queue.');
    interaction.editReply('Song skipped.');
    this.audioPlayer?.stop();
  }

  async stop(interaction: CommandInteraction<CacheType>) {
    if (!this.audioPlayer) return interaction.editReply('No music is playing.');
    this.audioPlayer?.removeAllListeners();
    this.queue = [];
    this.audioPlayer?.stop(true);
    this.voiceConnection?.removeAllListeners();
    this.voiceConnection?.destroy();
    this.voiceConnection = null;
    await interaction.editReply('Stopping the music and disconnecting from the voice channel.');
  }

  private async youtubeSearch(interaction: CommandInteraction<CacheType>, query: string) {
    try {
      const results = await ytsr(query, { limit: 5 });
      const tracks = results.items.filter((item) => item.type === 'video') as ytsr.Video[];
      if (!tracks.length) return interaction.editReply('No results found');
      const row = new MessageActionRow().addComponents(
        new MessageSelectMenu()
          .setCustomId('music')
          .setPlaceholder('Click here to select a music')
          .addOptions(
            tracks.map((item) => ({
              label: item.title,
              value: `${item.id}`,
            })),
          ),
      );
      this.currentInteration = interaction;
      await interaction.editReply({ content: 'Select a song!', components: [row] });
    } catch (error) {
      this._internalErrorMessage(error);
    }
  }

  async selectMusic(interaction: SelectMenuInteraction<CacheType>) {
    if (interaction.message.interaction?.id !== this.currentInteration?.id) return interaction.update({ content: 'Wrong interaction', components: [] });
    if (!interaction.values.length) return interaction.editReply('Nothing selected');
    const id = interaction.values[0];

    try {
      const videoInfo = await ytdl.getInfo(id);
      this.queue.push(videoInfo);
      this._play();
      interaction.update({
        content: `${videoInfo.videoDetails.title} added to the queue.`,
        components: [],
      });
    } catch (error) {
      this._internalErrorMessage(error);
    }
  }

  private async _play() {
    try {
      if (!this.queue.length) return;
      if (this.audioPlayer?.state.status === AudioPlayerStatus.Playing) return;
      if (!this.voiceConnection) {
        this._connectVoiceChannel();
      }
      let data = this.queue[0];
      if (typeof data === 'string') {
        data = await ytdl.getInfo(data);
      }
      this.currentInfo = data;
      const filteredFormats = data.formats
        .filter((item) => !!item.audioBitrate)
        .sort((a, b) => {
          if (!a.audioBitrate || !b.audioBitrate) return 1;
          return b.audioBitrate - a.audioBitrate;
        });

      if (!filteredFormats.length) return this._internalErrorMessage('No audio formats found after filtering');
      const format = filteredFormats[0];
      const resource = createAudioResource(createYTStream(data, format, {}));
      this.audioPlayer?.play(resource);
    } catch (error) {
      this._internalErrorMessage(error);
    }
  }

  private async _connectVoiceChannel() {
    if (!this.audioPlayer) {
      this.audioPlayer = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Play,
        },
      });
      this.audioPlayer.on('error', (err) => console.log('Audio player error', err));
      // @ts-ignore
      this.audioPlayer.on('stateChange', (_old, _new) => this._audioPlayerStateListener(_old, _new));
    }

    const guildMember = this.currentInteration?.member as GuildMember;
    if (this.voiceConnection || !guildMember || !guildMember.voice.channelId) return this.currentInteration?.editReply('No voice channel found');
    this.voiceConnection = joinVoiceChannel({
      channelId: guildMember.voice.channelId,
      guildId: guildMember.guild.id,
      adapterCreator: guildMember.guild.voiceAdapterCreator,
    });
    this.voiceConnection.on('error', (err) => console.log('Connection error', err));

    this.voiceConnection.subscribe(this.audioPlayer);
  }

  private async _audioPlayerStateListener(oldState: AudioPlayerState, newState: AudioPlayerState) {
    if (
      oldState.status === AudioPlayerStatus.Playing
      && newState.status === AudioPlayerStatus.Idle
    ) {
      console.log('Song ended');
      this.queue.shift();
      if (this.queue.length) return this._play();
      this.currentInteration?.followUp(
        'Music queue is empty, So I will disconnect from the voice channel.',
      );
      this.voiceConnection?.destroy();
      this.voiceConnection = null;
    }

    if (
      oldState.status === AudioPlayerStatus.Buffering
      && newState.status === AudioPlayerStatus.Playing
    ) {
      try {
        const data = this.currentInfo;
        if (!data) return this._internalErrorMessage('No current info');
        const {
          title, video_url, thumbnails, lengthSeconds,
        } = data.videoDetails;
        const minutes = secondsToMinutes(Number(lengthSeconds));
        const embed = new MessageEmbed()
          .setTitle('Now playing: ')
          .setDescription(`[${title}](${video_url}/ 'Click to open link.') `)
          .setTimestamp()
          .setFooter({ text: `Duration: ${minutes}` });
        if (thumbnails.length) embed.setThumbnail(thumbnails[0].url);
        this.currentInteration?.channel?.send({ embeds: [embed] });
      } catch (error) {
        this._internalErrorMessage(error);
      }
    }
  }

  async _internalErrorMessage(error: unknown) {
    console.error(error);
    if (this.currentInteration) {
      this.currentInteration.editReply('Something went wrong, please try again later.');
    }
  }
}