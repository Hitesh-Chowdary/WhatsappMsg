import React, { useState, useEffect, useRef } from 'react';

const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "http://localhost:8000" : "";
const RECORDS_PER_PAGE = 15;

function App() {
  // Auth State
  const [token, setToken] = useState(localStorage.getItem('jwt_token') || null);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // Stats State
  const [stats, setStats] = useState({
    total: 0,
    sent: 0,
    unsent: 0,
    read: 0,
    failed: 0,
    interested: 0,
    not_interested: 0
  });

  // Authenticated Fetch Wrapper
  const authFetch = async (url, options = {}) => {
    const headers = {
      ...options.headers,
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    };
    
    try {
      const res = await fetch(url, { ...options, headers });
      if (res.status === 401) {
        localStorage.removeItem('jwt_token');
        setToken(null);
        triggerToast("Session expired or unauthorized. Please log in.", "error");
      }
      return res;
    } catch (err) {
      console.error("API request failed:", err);
      throw err;
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!loginUsername.trim() || !loginPassword.trim()) {
      setLoginError("Please enter both username and password.");
      return;
    }
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: loginUsername,
          password: loginPassword
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || "Invalid credentials.");
      }
      
      localStorage.setItem('jwt_token', data.access_token);
      setToken(data.access_token);
      triggerToast("Logged in successfully.", "success");
    } catch (err) {
      setLoginError(err.message || "Failed to connect to the authentication server.");
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('jwt_token');
    setToken(null);
    setLoginUsername('');
    setLoginPassword('');
    triggerToast("Logged out successfully.", "info");
  };

  // Records and Grid State
  const [records, setRecords] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [dispatchFilter, setDispatchFilter] = useState('all'); // 'all', 'unsent', 'sent', 'failed'
  const [deliveryFilter, setDeliveryFilter] = useState('all'); // 'all', 'undelivered', 'delivered'
  const [readFilter, setReadFilter] = useState('all'); // 'all', 'not_read', 'read'
  const [responseFilter, setResponseFilter] = useState('all'); // 'all', 'no_response', 'interested', 'not_interested'
  const [search, setSearch] = useState('');
  const [gridLoading, setGridLoading] = useState(true);
  const [gridError, setGridError] = useState('');
  const [branchFilter, setBranchFilter] = useState('all');
  const [branches, setBranches] = useState([]);
  const [selectedRecordIds, setSelectedRecordIds] = useState([]);

  // Custom Confirm Modal State
  const [confirmModal, setConfirmModal] = useState({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: null
  });

  const closeConfirmModal = () => {
    setConfirmModal(prev => ({ ...prev, isOpen: false }));
  };

  const isRecordEligibleForBulk = (rec) => {
    const campaignStatus = (rec.campaign_status || '').toLowerCase();
    const deliveryStatus = (rec.delivery_status || '').toLowerCase();
    const response = (rec.parent_response || '').toLowerCase();
    
    // Confirmed interested parents are excluded from bulk outreach
    if (response === 'interested') return false;
    
    // Unsent, failed, or not interested parents are eligible
    return (
      campaignStatus === 'pending' || 
      campaignStatus === 'failed' || 
      deliveryStatus === 'unsent' || 
      deliveryStatus === 'failed' ||
      response === 'not interested'
    );
  };

  // Template State
  const [templateText, setTemplateText] = useState('');
  const [mediaType, setMediaType] = useState('none'); // 'none', 'image', 'document'
  const [mediaUrl, setMediaUrl] = useState(null);
  const [mediaFilename, setMediaFilename] = useState('');
  const [mediaUploading, setMediaUploading] = useState(false);
  const [saveStatus, setSaveStatus] = useState('synced'); // synced, unsaved, saving

  // Uploader State
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatusText, setUploadStatusText] = useState('');
  const [parsedColumns, setParsedColumns] = useState([]);

  // Dev Sandbox Simulator State
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [consoleLogs, setConsoleLogs] = useState([
    { time: new Date().toLocaleTimeString(), text: "Sandbox initialized. Ready for simulation.", level: "info" }
  ]);
  const [simButtonsDisabled, setSimButtonsDisabled] = useState(false);

  // Notifications State
  const [toasts, setToasts] = useState([]);

  // Refs for upload and search debounce
  const fileInputRef = useRef(null);
  const searchTimeoutRef = useRef(null);
  const logsEndRef = useRef(null);

  // ----------------------------------------------------
  // LIFECYCLE & POLLING
  // ----------------------------------------------------
  // Keep latest filter, search, page state in a ref to avoid stale closures in the polling interval
  const pollingStateRef = useRef({ currentPage, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter });
  useEffect(() => {
    pollingStateRef.current = { currentPage, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter };
  }, [currentPage, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter]);

  // ----------------------------------------------------
  // LIFECYCLE & POLLING
  // ----------------------------------------------------
  useEffect(() => {
    if (!token) return;
    
    // Initial fetch
    fetchStats();
    fetchTemplate();
    fetchBranches();
    fetchRecords(1, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter);

    // Poll statistics and grid periodically to pick up async background sends
    const interval = setInterval(() => {
      fetchStats();
      fetchBranches();
      fetchRecords(
        pollingStateRef.current.currentPage, 
        pollingStateRef.current.dispatchFilter, 
        pollingStateRef.current.deliveryFilter, 
        pollingStateRef.current.readFilter, 
        pollingStateRef.current.responseFilter, 
        pollingStateRef.current.search, 
        pollingStateRef.current.branchFilter, 
        false
      ); // silent refresh without full loader
    }, 6000);

    return () => clearInterval(interval);
  }, [token]);

  // Cascading dependency handlers
  const handleDispatchFilterChange = (val) => {
    setDispatchFilter(val);
    if (val !== 'sent') {
      setDeliveryFilter('all');
      setReadFilter('all');
      setResponseFilter('all');
    }
  };

  const handleDeliveryFilterChange = (val) => {
    setDeliveryFilter(val);
    if (val !== 'delivered') {
      setReadFilter('all');
      setResponseFilter('all');
    }
  };

  const handleReadFilterChange = (val) => {
    setReadFilter(val);
    if (val !== 'read') {
      setResponseFilter('all');
    }
  };

  // Handle filter changes
  useEffect(() => {
    if (!token) return;
    setCurrentPage(1);
    fetchRecords(1, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter);
  }, [dispatchFilter, deliveryFilter, readFilter, responseFilter, branchFilter, token]);

  // Handle search changes with 300ms debounce
  useEffect(() => {
    if (!token) return;
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    
    searchTimeoutRef.current = setTimeout(() => {
      setCurrentPage(1);
      fetchRecords(1, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter);
    }, 300);

    return () => clearTimeout(searchTimeoutRef.current);
  }, [search, token]);

  // Reset selected checkboxes on filter/search or page change
  useEffect(() => {
    setSelectedRecordIds([]);
  }, [dispatchFilter, deliveryFilter, readFilter, responseFilter, branchFilter, search, currentPage]);

  // Scroll sandbox logs to bottom
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [consoleLogs]);

  // Update sandbox simulator details if active record changes status
  useEffect(() => {
    if (selectedRecord) {
      const match = records.find(r => r.id === selectedRecord.id);
      if (match) {
        setSelectedRecord(match);
        setSimButtonsDisabled(false);
      }
    }
  }, [records]);

  // Trigger Excel download of filtered results
  const handleExportExcel = async () => {
    const params = new URLSearchParams();
    
    // Formulate parameters identical to fetchRecords
    if (dispatchFilter === 'unsent') {
      params.append('campaign_status', 'Pending');
    } else if (dispatchFilter === 'failed') {
      params.append('campaign_status', 'Failed');
    } else if (dispatchFilter === 'sent') {
      params.append('campaign_status', 'Sent');
      
      if (deliveryFilter === 'undelivered') {
        params.append('delivery_status', 'undelivered');
      } else if (deliveryFilter === 'delivered') {
        if (readFilter === 'not_read') {
          params.append('delivery_status', 'not_read');
        } else if (readFilter === 'read') {
          if (responseFilter === 'no_response') {
            params.append('parent_response', 'No Response');
            params.append('delivery_status', 'read');
          } else if (responseFilter === 'interested') {
            params.append('parent_response', 'Interested');
            params.append('delivery_status', 'read');
          } else if (responseFilter === 'not_interested') {
            params.append('parent_response', 'Not Interested');
            params.append('delivery_status', 'read');
          } else {
            params.append('delivery_status', 'read');
          }
        } else {
          params.append('delivery_status', 'delivered');
        }
      }
    }
    
    if (search.trim()) {
      params.append('search', search.trim());
    }
    
    if (branchFilter && branchFilter !== 'all') {
      params.append('branch', branchFilter);
    }
    
    try {
      triggerToast("Generating Excel export...", "info");
      const res = await authFetch(`${API_BASE}/api/v1/records/export?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to generate export file from server.");
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `filtered_contacts_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      triggerToast("Excel export downloaded successfully.", "success");
    } catch (err) {
      console.error(err);
      triggerToast(err.message || "Failed to export Excel.", "error");
    }
  };

  // ----------------------------------------------------

  // TOAST ALERTS SYSTEM
  // ----------------------------------------------------
  const triggerToast = (message, type = 'info') => {
    const id = Date.now() + Math.random().toString(36).substr(2, 5);
    setToasts(prev => [...prev, { id, message, type }]);
    
    // Auto dismiss after 4 seconds
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  const removeToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  // ----------------------------------------------------
  // CONSOLE LOGGER HELPERS
  // ----------------------------------------------------
  const addLog = (text, level = 'info') => {
    setConsoleLogs(prev => [...prev, {
      time: new Date().toLocaleTimeString(),
      text,
      level
    }]);
  };

  // ----------------------------------------------------
  // API CALLS
  // ----------------------------------------------------

  // Fetch Dashboard aggregate statistics
  const fetchStats = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/stats`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setStats(data);
    } catch (err) {
      console.error("Failed to load statistics counters.");
    }
  };

  // Fetch unique academic branches present in database
  const fetchBranches = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/branches`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setBranches(data);
    } catch (err) {
      console.error("Failed to load academic branches.");
    }
  };

  // Fetch paginated grid records
  const fetchRecords = async (page, dispatchF, deliveryF, readF, responseF, searchTerm, branchF, showLoader = true) => {
    if (showLoader) setGridLoading(true);
    
    const params = new URLSearchParams();
    params.append('page', page);
    params.append('limit', RECORDS_PER_PAGE);
    
    if (searchTerm.trim()) params.append('search', searchTerm.trim());
    
    if (branchF && branchF !== 'all') {
      params.append('branch', branchF);
    }

    // Level 1: Dispatch
    if (dispatchF === 'unsent') {
      params.append('campaign_status', 'Pending');
    } else if (dispatchF === 'failed') {
      params.append('campaign_status', 'Failed');
    } else if (dispatchF === 'sent') {
      params.append('campaign_status', 'Sent');
      
      // Level 2: Delivery
      if (deliveryF === 'undelivered') {
        params.append('delivery_status', 'undelivered');
      } else if (deliveryF === 'delivered') {
        // Level 3: Read Status
        if (readF === 'not_read') {
          params.append('delivery_status', 'not_read');
        } else if (readF === 'read') {
          // Level 4: Response
          if (responseF === 'no_response') {
            params.append('parent_response', 'No Response');
            params.append('delivery_status', 'read');
          } else if (responseF === 'interested') {
            params.append('parent_response', 'Interested');
            params.append('delivery_status', 'read');
          } else if (responseF === 'not_interested') {
            params.append('parent_response', 'Not Interested');
            params.append('delivery_status', 'read');
          } else {
            params.append('delivery_status', 'read');
          }
        } else {
          params.append('delivery_status', 'delivered');
        }
      }
    }

    try {
      const res = await authFetch(`${API_BASE}/api/v1/records?${params.toString()}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      
      setRecords(data.records);
      setTotalCount(data.total);
      setCurrentPage(data.page);
      setTotalPages(data.pages);
      setGridError('');
    } catch (err) {
      console.error(err);
      setGridError("Failed to retrieve admission details from the database.");
    } finally {
      if (showLoader) setGridLoading(false);
    }
  };

  // Fetch template text
  const fetchTemplate = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/template`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setTemplateText(data.template_text);
      setMediaType(data.media_type || 'none');
      setMediaUrl(data.media_url || null);
      if (data.media_url) {
        const parts = data.media_url.split('/');
        setMediaFilename(parts[parts.length - 1]);
      } else {
        setMediaFilename('');
      }
      setSaveStatus('synced');
    } catch (err) {
      console.error(err);
      triggerToast("Error loading outreach template from database.", "error");
    }
  };

  // Save template text
  const handleSaveTemplate = async () => {
    if (!templateText.trim()) {
      triggerToast("Template text cannot be empty.", "error");
      return;
    }
    setSaveStatus('saving');
    try {
      const res = await authFetch(`${API_BASE}/api/v1/template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          template_text: templateText,
          media_type: mediaType,
          media_url: mediaUrl
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to save template.");
      
      setTemplateText(data.template_text);
      setMediaType(data.media_type || 'none');
      setMediaUrl(data.media_url || null);
      setSaveStatus('synced');
      triggerToast("Template saved successfully.", "success");
    } catch (err) {
      setSaveStatus('unsaved');
      triggerToast(err.message, "error");
    }
  };

  // Upload template media file
  const handleMediaUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    setMediaUploading(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/template/upload-media`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Media upload failed.");

      setMediaUrl(data.media_url);
      setMediaFilename(file.name);
      setSaveStatus('unsaved');
      triggerToast("Media file uploaded successfully.", "success");
    } catch (err) {
      triggerToast(err.message, "error");
    } finally {
      setMediaUploading(false);
      e.target.value = '';
    }
  };

  // Upload spreadsheet
  const handleFileUpload = async (file) => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext !== 'xlsx' && ext !== 'csv') {
      triggerToast("Invalid format. Please upload an Excel (.xlsx) or CSV (.csv) file.", "error");
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    setUploading(true);
    setUploadProgress(0);
    setUploadStatusText(`Uploading file: ${file.name}...`);

    // Animate progress bar loader
    let width = 0;
    const progressInterval = setInterval(() => {
      if (width < 90) {
        width += 15;
        setUploadProgress(width);
      }
    }, 80);

    try {
      const res = await authFetch(`${API_BASE}/api/v1/upload`, {
        method: 'POST',
        body: formData
      });
      clearInterval(progressInterval);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Upload ingestion failed.");

      setUploadProgress(100);
      setUploadStatusText(`Success: ${data.message}`);
      triggerToast(data.message, "success");
      setParsedColumns(data.columns || []);

      setTimeout(() => {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
        refreshDashboard();
      }, 1500);

    } catch (err) {
      clearInterval(progressInterval);
      setUploadProgress(0);
      setUploadStatusText(`Ingestion Failed: ${err.message}`);
      triggerToast(err.message, "error");
      setTimeout(() => setUploading(false), 3000);
    }
  };

  // Launch broadcast campaign
  const handleLaunchBroadcast = async () => {
    setConfirmModal({
      isOpen: true,
      title: 'Launch Broadcast Campaign',
      message: 'Are you sure you want to launch the broadcast campaign? This will send outreach messages to all pending candidates in the database.',
      onConfirm: async () => {
        closeConfirmModal();
        try {
          const res = await authFetch(`${API_BASE}/api/v1/campaign/broadcast`, { method: 'POST' });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || "Broadcast trigger failed.");

          if (data.status === 'ignored') {
            triggerToast(data.message, "info");
          } else {
            triggerToast(data.message, "success");
          }
          setTimeout(refreshDashboard, 1000);
        } catch (err) {
          triggerToast(err.message, "error");
        }
      }
    });
  };

  // Dispatch campaign to single contact
  const handleSendSingle = async (id) => {
    triggerToast("Dispatching single campaign request...", "info");
    try {
      const res = await authFetch(`${API_BASE}/api/v1/campaign/send-single/${id}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Single sending failed.");
      
      triggerToast(data.message, "success");
      refreshDashboard();
    } catch (err) {
      triggerToast(err.message, "error");
    }
  };

  // Trigger bulk campaign messages
  const handleBulkSend = async () => {
    if (selectedRecordIds.length === 0) return;
    
    const eligibleRecords = records.filter(r => selectedRecordIds.includes(r.id) && r.parent_response !== 'Interested');
    const interestedCount = selectedRecordIds.length - eligibleRecords.length;
    
    if (eligibleRecords.length === 0) {
      triggerToast("No eligible candidates selected. Outreach is disabled for confirmed Interested parents.", "error");
      return;
    }
    
    let confirmMsg = `Are you sure you want to send outreach messages to ${eligibleRecords.length} selected candidate(s)?`;
    if (interestedCount > 0) {
      confirmMsg += ` (${interestedCount} confirmed Interested parent(s) will be automatically skipped to prevent spam.)`;
    }
    
    setConfirmModal({
      isOpen: true,
      title: 'Confirm Outreach Dispatch',
      message: confirmMsg,
      onConfirm: async () => {
        closeConfirmModal();
        triggerToast("Initiating bulk campaign dispatch...", "info");
        try {
          const res = await authFetch(`${API_BASE}/api/v1/campaign/send-bulk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ record_ids: eligibleRecords.map(r => r.id) })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || "Failed to trigger bulk dispatch.");
          
          triggerToast(data.message, "success");
          setSelectedRecordIds([]);
          setTimeout(refreshDashboard, 1000);
        } catch (err) {
          triggerToast(err.message, "error");
        }
      }
    });
  };

  // Trigger simulated webhooks
  const triggerWebhookSimulation = async (state) => {
    if (!selectedRecord) return;
    addLog(`Firing webhook payload simulation -> target state: '${state}'...`, 'info');

    try {
      const res = await authFetch(`${API_BASE}/api/v1/simulation/webhook-trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          record_id: selectedRecord.id,
          target_state: state
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Simulation failed.");

      addLog(`Webhook Success: Status transitioned to '${state}' for '${selectedRecord.student_name}'.`, 'success');
      triggerToast(`Simulated response: ${state}`, "success");
      refreshDashboard();
    } catch (err) {
      addLog(`Webhook Failed: ${err.message}`, 'error');
      triggerToast(err.message, "error");
    }
  };

  // Reset uploader display
  const handleResetUploader = () => {
    setParsedColumns([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Helper refresh
  const refreshDashboard = () => {
    fetchStats();
    fetchRecords(
      pollingStateRef.current.currentPage, 
      pollingStateRef.current.dispatchFilter, 
      pollingStateRef.current.deliveryFilter, 
      pollingStateRef.current.readFilter, 
      pollingStateRef.current.responseFilter, 
      pollingStateRef.current.search, 
      false
    );
  };

  // ----------------------------------------------------
  // INTERACTIVE TEMPLATE PREVIEW HELPERS
  // ----------------------------------------------------
  const renderLivePreviewText = () => {
    if (!templateText) {
      return <span className="text-muted">Type template text above...</span>;
    }
    
    let preview = escapeHTML(templateText);
    preview = preview.replace(/\[Parent Name\]/g, '<span class="var">Rohan Kumar</span>');
    preview = preview.replace(/\[Student Name\]/g, '<span class="var">Rajesh Kumar</span>');
    preview = preview.replace(/\[Selected Branch\]/g, '<span class="var">Computer Science</span>');
    preview = preview.replace(/\[Phone Number\]/g, '<span class="var">919876543210</span>');
    
    return <span dangerouslySetInnerHTML={{ __html: preview }} />;
  };

  const insertToken = (token) => {
    const editor = document.getElementById('template-editor-textarea');
    if (!editor) return;

    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const text = templateText;

    const newText = text.substring(0, start) + token + text.substring(end);
    setTemplateText(newText);
    setSaveStatus('unsaved');

    // Return focus to editor
    setTimeout(() => {
      editor.focus();
      editor.selectionStart = editor.selectionEnd = start + token.length;
    }, 0);
  };

  // ----------------------------------------------------
  // COMPONENT EVENT HANDLERS
  // ----------------------------------------------------
  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };

  const selectSimTarget = (rec) => {
    setSelectedRecord(rec);
    setSimButtonsDisabled(false);
    setDrawerOpen(true);
    addLog(`Selected target student: ${rec.student_name} (Phone: ${rec.phone_number})`, 'info');
  };

  // Helper helper
  const changePage = (dir) => {
    const target = currentPage + dir;
    if (target >= 1 && target <= totalPages) {
      setCurrentPage(target);
      fetchRecords(target, dispatchFilter, deliveryFilter, readFilter, responseFilter, search);
    }
  };

  // ----------------------------------------------------
  // HTML ESCAPE AND UTILITIES
  // ----------------------------------------------------
  function escapeHTML(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Calc read percentage rates
  const readRate = stats.sent > 0 ? Math.round((stats.read / stats.sent) * 100) : 0;

  if (!token) {
    return (
      <div className="login-screen-container">
        <div className="login-card">
          <div className="login-card-header">
            <div className="login-logo">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
            </div>
            <h2>Admin Portal</h2>
            <p>Sign in to access the admission engine</p>
          </div>

          {loginError && (
            <div className="login-error-alert">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <span>{loginError}</span>
            </div>
          )}

          <form onSubmit={handleLogin}>
            <div className="login-form-group">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                type="text"
                className="login-input"
                placeholder="Enter username"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                disabled={loginLoading}
                required
              />
            </div>

            <div className="login-form-group">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                className="login-input"
                placeholder="Enter password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                disabled={loginLoading}
                required
              />
            </div>

            <button type="submit" className="login-button" disabled={loginLoading}>
              {loginLoading ? (
                <>Signing in...</>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
                    <polyline points="10 17 15 12 10 7"></polyline>
                    <line x1="15" y1="12" x2="3" y2="12"></line>
                  </svg>
                  Sign In
                </>
              )}
            </button>
          </form>
        </div>

        {/* Global notifications toaster container */}
        <div className="toast-container">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast toast-${toast.type} show`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ color: 'inherit', display: 'flex', alignItems: 'center' }}>
                  {toast.type === 'success' && (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  )}
                  {toast.type === 'error' && (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                  )}
                  {toast.type === 'info' && (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                  )}
                </span>
                <span className="toast-content">{toast.message}</span>
              </div>
              <button onClick={() => removeToast(toast.id)} className="btn-toast-close">&times;</button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`app-wrapper ${drawerOpen ? 'drawer-open' : ''}`}>
      {/* 2. Main Content View Area */}
      <main className="app-content">
        
        {/* Header Title Bar */}
        <header className="dashboard-header">
          <div className="header-titles">
            <span className="header-meta">Access Management</span>
            <h1>Student Accounts</h1>
            <p className="subtitle">Create student accounts individually or provision them in bulk by importing spreadsheets.</p>
          </div>
          
          <div style={{ display: 'flex', gap: '12px' }}>
            <button onClick={() => setDrawerOpen(true)} className="btn btn-secondary btn-sandbox">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                <line x1="8" y1="21" x2="16" y2="21"></line>
                <line x1="12" y1="17" x2="12" y2="21"></line>
              </svg>
              Dev Sandbox Simulator
            </button>
            <button onClick={handleLogout} className="btn btn-secondary" style={{ borderColor: 'var(--color-coral)', color: 'var(--color-coral)' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px' }}>
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                <polyline points="16 17 21 12 16 7"></polyline>
                <line x1="21" y1="12" x2="9" y2="12"></line>
              </svg>
              Logout
            </button>
          </div>
        </header>

        {/* Analytics statistical counters grid */}
        <section className="analytics-grid">
          <div className="stat-card">
            <div className="stat-icon icon-blue">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                <circle cx="9" cy="7" r="4"></circle>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-label">Total Uploaded</span>
              <h3 className="stat-value">{stats.total.toLocaleString()}</h3>
              <p className="stat-desc">Parents in database</p>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon icon-purple">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-label">Campaign Sent</span>
              <h3 className="stat-value">{stats.sent.toLocaleString()}</h3>
              <p className="stat-desc">{stats.unsent.toLocaleString()} unsent/pending</p>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon icon-amber">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-label">Read / Seen</span>
              <h3 className="stat-value">{stats.read.toLocaleString()}</h3>
              <p className="stat-desc">{readRate}% read conversion</p>
            </div>
          </div>

          <div className="stat-card stat-highlight-emerald">
            <div className="stat-icon icon-emerald">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                <polyline points="22 4 12 14.01 9 11.01"></polyline>
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-label text-emerald">Interested</span>
              <h3 className="stat-value text-emerald">{stats.interested.toLocaleString()}</h3>
              <span className="stat-badge badge-glow-emerald">Action Required</span>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon icon-coral">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="15" y1="9" x2="9" y2="15"></line>
                <line x1="9" y1="9" x2="15" y2="15"></line>
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-label">Not Interested</span>
              <h3 className="stat-value">{stats.not_interested.toLocaleString()}</h3>
              <p className="stat-desc">Seats released</p>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon" style={{ backgroundColor: 'var(--color-coral-light)', border: '1px solid var(--color-coral-border)', color: 'var(--color-coral)' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-label">Delivery Failed</span>
              <h3 className="stat-value">{(stats.failed || 0).toLocaleString()}</h3>
              <p className="stat-desc">Requires manual retry</p>
            </div>
          </div>
        </section>

        {/* File Ingestion & Campaign Control Cards */}
        <section className="control-center">
          
          {/* File Upload Panel (Left Side) */}
          <div className="glass-panel upload-panel">
            <div class="panel-header">
              <h4>Excel Ingestion Engine</h4>
            </div>

            {parsedColumns.length === 0 ? (
              <div 
                className={`drop-zone ${dragActive ? 'dragover' : ''}`}
                onDragEnter={handleDrag}
                onDragOver={handleDrag}
                onDragLeave={handleDrag}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current.click()}
              >
                <input 
                  type="file" 
                  ref={fileInputRef}
                  accept=".xlsx,.csv" 
                  className="hidden-input"
                  onChange={(e) => e.target.files[0] && handleFileUpload(e.target.files[0])}
                />
                <div className="drop-zone-content">
                  <svg className="upload-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                  </svg>
                  <p className="upload-title">Drag & drop spreadsheet here</p>
                  <p className="upload-subtitle">Supports .xlsx or .csv up to 2,000 numbers</p>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={(e) => {e.stopPropagation(); fileInputRef.current.click();}}>Browse Files</button>
                </div>
              </div>
            ) : (
              <div className="columns-display-container">
                <div className="columns-display-header">
                  <h5>Spreadsheet Columns Parsed</h5>
                  <p className="columns-desc">The following headers were auto-mapped from your file:</p>
                </div>
                <div className="parsed-columns-list">
                  {parsedColumns.map((col, idx) => (
                    <span key={idx} className="column-pill">{col}</span>
                  ))}
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={handleResetUploader} style={{marginTop: 'auto', width: '100%'}}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                  </svg>
                  Upload Another Spreadsheet
                </button>
              </div>
            )}

            {uploading && (
              <div className="upload-progress-container">
                <div className="progress-bar-bg">
                  <div className="progress-bar-fill" style={{ width: `${uploadProgress}%` }}></div>
                </div>
                <p className="progress-text">{uploadStatusText}</p>
              </div>
            )}
          </div>

          {/* Campaign Controls (Right Side - Customizable Template) */}
          <div className="glass-panel campaign-panel">
            <div class="panel-header">
              <h4>Campaign Control Center</h4>
            </div>
            
            <div className="campaign-desc-container">
              <div className="template-editor-group">
                <div className="editor-header">
                  <label htmlFor="template-editor-textarea" className="editor-label">Outreach Message Body Template</label>
                  <button 
                    onClick={handleSaveTemplate} 
                    className="btn btn-secondary btn-sm" 
                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                    disabled={saveStatus === 'saving'}
                  >
                    {saveStatus === 'saving' ? 'Saving...' : 'Save Template'}
                  </button>
                </div>
                
                <textarea 
                  id="template-editor-textarea" 
                  className="template-editor" 
                  rows={4} 
                  placeholder="Dear [Parent Name], your child [Student Name]..."
                  value={templateText}
                  onChange={(e) => { setTemplateText(e.target.value); setSaveStatus('unsaved'); }}
                />
                
                <div className="editor-help-text">
                  Available Tokens (Click to insert): {' '}
                  <span className="placeholder-tag" onClick={() => insertToken('[Parent Name]')} title="Maps parent name column">[Parent Name]</span>{' '}
                  <span className="placeholder-tag" onClick={() => insertToken('[Student Name]')} title="Maps student name column">[Student Name]</span>{' '}
                  <span className="placeholder-tag" onClick={() => insertToken('[Selected Branch]')} title="Maps selected branch column">[Selected Branch]</span>{' '}
                  <span className="placeholder-tag" onClick={() => insertToken('[Phone Number]')} title="Maps phone number">[Phone Number]</span>
                </div>

                {/* Media Attachment Selector */}
                <div className="media-selector-group" style={{ marginTop: '0.75rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                  <span className="editor-label" style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.75rem' }}>Outreach Media Attachment</span>
                  <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <button 
                      type="button" 
                      className={`btn btn-sm ${mediaType === 'none' ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => { setMediaType('none'); setMediaUrl(null); setMediaFilename(''); setSaveStatus('unsaved'); }}
                    >
                      None
                    </button>
                    <button 
                      type="button" 
                      className={`btn btn-sm ${mediaType === 'image' ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => { setMediaType('image'); setSaveStatus('unsaved'); }}
                    >
                      Image (PNG/JPG)
                    </button>
                    <button 
                      type="button" 
                      className={`btn btn-sm ${mediaType === 'document' ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => { setMediaType('document'); setSaveStatus('unsaved'); }}
                    >
                      Document (PDF)
                    </button>
                  </div>

                  {mediaType !== 'none' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {!mediaUrl ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <input 
                            type="file" 
                            accept={mediaType === 'image' ? "image/*" : ".pdf,.docx,.xlsx"} 
                            onChange={handleMediaUpload} 
                            style={{ display: 'none' }} 
                            id="media-file-input" 
                          />
                          <button 
                            type="button" 
                            className="btn btn-secondary btn-sm" 
                            onClick={() => document.getElementById('media-file-input').click()}
                            disabled={mediaUploading}
                          >
                            {mediaUploading ? 'Uploading...' : `Upload ${mediaType === 'image' ? 'Image' : 'Document'}`}
                          </button>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                            Or paste a public URL below:
                          </span>
                        </div>
                      ) : (
                        <div className="column-pill" style={{ width: 'max-content', paddingRight: '0.5rem' }}>
                          <span style={{ wordBreak: 'break-all' }}>{mediaFilename || 'Attachment uploaded'}</span>
                          <button 
                            type="button" 
                            style={{ background: 'none', border: 'none', color: 'var(--color-coral)', cursor: 'pointer', fontWeight: 'bold', marginLeft: '0.5rem' }}
                            onClick={() => { setMediaUrl(null); setMediaFilename(''); setSaveStatus('unsaved'); }}
                          >
                            &times;
                          </button>
                        </div>
                      )}
                      
                      <input 
                        type="text" 
                        placeholder={mediaType === 'image' ? "https://example.com/image.jpg" : "https://example.com/fees.pdf"}
                        value={mediaUrl || ''}
                        onChange={(e) => { setMediaUrl(e.target.value); setMediaFilename(e.target.value.split('/').pop()); setSaveStatus('unsaved'); }}
                        className="template-editor"
                        style={{ padding: '0.4rem 0.6rem', fontSize: '0.75rem' }}
                      />
                    </div>
                  )}
                </div>
              </div>
              
              <div className="message-preview">
                <div className="preview-header">
                  <span className="preview-label">Compiled Message Preview (Sample Record)</span>
                  <span className={`save-status-indicator ${saveStatus === 'unsaved' ? 'unsaved' : 'synced'}`}>
                    {saveStatus === 'unsaved' ? 'Unsaved Changes' : 'Synced'}
                  </span>
                </div>

                {/* Media Preview Box */}
                {mediaType !== 'none' && mediaUrl && (
                  <div style={{ marginBottom: '0.75rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem', display: 'flex', justifyContent: 'center', backgroundColor: '#f1f5f9', borderRadius: '4px', overflow: 'hidden' }}>
                    {mediaType === 'image' ? (
                      <img 
                        src={mediaUrl.startsWith('/static/') ? `${API_BASE}${mediaUrl}` : mediaUrl} 
                        alt="Preview" 
                        style={{ maxWidth: '100%', maxHeight: '150px', objectFit: 'contain' }}
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', backgroundColor: '#ffffff', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '0.813rem', width: '90%' }}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-coral)" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                        <span style={{ fontWeight: '600', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexGrow: 1 }}>
                          {mediaFilename || 'document.pdf'}
                        </span>
                        <a 
                          href={mediaUrl.startsWith('/static/') ? `${API_BASE}${mediaUrl}` : mediaUrl} 
                          target="_blank" 
                          rel="noreferrer"
                          style={{ fontSize: '0.75rem', color: 'var(--color-blue)', textDecoration: 'none', fontWeight: 'bold' }}
                        >
                          View File
                        </a>
                      </div>
                    )}
                  </div>
                )}

                <p className="preview-body">
                  {renderLivePreviewText()}
                </p>
              </div>
            </div>

            <div className="campaign-actions">
              <button onClick={handleLaunchBroadcast} className="btn btn-primary btn-lg btn-block">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                Launch Broadcast Campaign
              </button>
            </div>
          </div>
        </section>

        {/* Data Table Filters & Grid Panel */}
        <section className="glass-panel grid-panel">
          <div className="grid-panel-header">
            <div className="funnel-filter-bar">
              <div className="filter-group">
                <span className="filter-label">1. Dispatch</span>
                <select 
                  value={dispatchFilter} 
                  onChange={(e) => handleDispatchFilterChange(e.target.value)} 
                  className="filter-select"
                >
                  <option value="all">All Dispatch States</option>
                  <option value="unsent">Unsent (Pending)</option>
                  <option value="sent">Sent</option>
                  <option value="failed">Failed</option>
                </select>
              </div>

              <div className={`filter-group ${dispatchFilter !== 'sent' ? 'disabled' : ''}`}>
                <span className="filter-label">2. Delivery</span>
                <select 
                  value={deliveryFilter} 
                  onChange={(e) => handleDeliveryFilterChange(e.target.value)} 
                  disabled={dispatchFilter !== 'sent'}
                  className="filter-select"
                >
                  <option value="all">All Delivery States</option>
                  <option value="undelivered">Undelivered</option>
                  <option value="delivered">Delivered</option>
                </select>
              </div>

              <div className={`filter-group ${dispatchFilter !== 'sent' || deliveryFilter !== 'delivered' ? 'disabled' : ''}`}>
                <span className="filter-label">3. Read Status</span>
                <select 
                  value={readFilter} 
                  onChange={(e) => handleReadFilterChange(e.target.value)} 
                  disabled={dispatchFilter !== 'sent' || deliveryFilter !== 'delivered'}
                  className="filter-select"
                >
                  <option value="all">All Read States</option>
                  <option value="not_read">Not Read</option>
                  <option value="read">Read</option>
                </select>
              </div>

              <div className={`filter-group ${dispatchFilter !== 'sent' || deliveryFilter !== 'delivered' || readFilter !== 'read' ? 'disabled' : ''}`}>
                <span className="filter-label">4. Response</span>
                <select 
                  value={responseFilter} 
                  onChange={(e) => setResponseFilter(e.target.value)} 
                  disabled={dispatchFilter !== 'sent' || deliveryFilter !== 'delivered' || readFilter !== 'read'}
                  className="filter-select"
                >
                  <option value="all">All Responses</option>
                  <option value="no_response">No Response</option>
                  <option value="interested">Interested</option>
                  <option value="not_interested">Not Interested</option>
                </select>
              </div>
              <div className="filter-group">
                <span className="filter-label">Branch</span>
                <select 
                  value={branchFilter} 
                  onChange={(e) => setBranchFilter(e.target.value)} 
                  className="filter-select"
                >
                  <option value="all">All Branches</option>
                  {branches.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid-header-actions" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="search-container">
                <svg className="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                <input 
                  type="text" 
                  placeholder="Search student, parent, phone..." 
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <button 
                onClick={handleExportExcel} 
                className="btn btn-success"
                style={{ height: '38px', display: 'inline-flex', alignItems: 'center', gap: '0.5rem', whiteSpace: 'nowrap', padding: '0.5rem 1rem' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                Export Excel
              </button>
            </div>
          </div>

          {selectedRecordIds.length > 0 && (
            <div className="bulk-action-bar" style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderRadius: 'var(--radius-sm)',
              padding: '0.75rem 1.25rem',
              margin: '0.75rem 1.5rem',
              animation: 'fadeIn 0.2s ease-in-out'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#1e40af', fontWeight: '600', fontSize: '0.875rem' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                  <polyline points="22 4 12 14.01 9 11.01"></polyline>
                </svg>
                <span>{selectedRecordIds.length} candidate(s) selected for bulk outreach</span>
              </div>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button 
                  onClick={handleBulkSend} 
                  className="btn btn-primary btn-sm"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                  </svg>
                  Send Outreach
                </button>
                <button 
                  onClick={() => setSelectedRecordIds([])} 
                  className="btn btn-secondary btn-sm"
                >
                  Clear Selection
                </button>
              </div>
            </div>
          )}

          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '40px', textAlign: 'center' }}>
                    <input 
                      type="checkbox" 
                      style={{ 
                        cursor: records.filter(isRecordEligibleForBulk).length > 0 ? 'pointer' : 'not-allowed', 
                        scale: '1.1' 
                      }}
                      checked={
                        records.length > 0 && 
                        records.filter(isRecordEligibleForBulk).length > 0 &&
                        records.filter(isRecordEligibleForBulk).every(r => selectedRecordIds.includes(r.id))
                      }
                      disabled={records.filter(isRecordEligibleForBulk).length === 0}
                      onChange={(e) => {
                        const eligiblePageIds = records.filter(isRecordEligibleForBulk).map(r => r.id);
                        if (e.target.checked) {
                          setSelectedRecordIds(prev => [...new Set([...prev, ...eligiblePageIds])]);
                        } else {
                          setSelectedRecordIds(prev => prev.filter(id => !eligiblePageIds.includes(id)));
                        }
                      }}
                    />
                  </th>
                  <th>Student Details</th>
                  <th>Parent Details</th>
                  <th>Branch</th>
                  <th>Phone Number</th>
                  <th>Delivery Status</th>
                  <th>Response</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {gridLoading ? (
                  <tr className="state-loading">
                    <td colSpan={8}>
                      <div className="loading-spinner-container">
                        <div className="spinner"></div>
                        <span>Loading records...</span>
                      </div>
                    </td>
                  </tr>
                ) : gridError ? (
                  <tr className="state-empty">
                    <td colSpan={8}>
                      <div className="empty-container">
                        <svg class="empty-icon text-coral" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                          <line x1="12" y1="9" x2="12" y2="13"></line>
                          <line x1="12" y1="17" x2="12.01" y2="17"></line>
                        </svg>
                        <span class="empty-title text-coral">Data Query Failed</span>
                        <span class="empty-desc">{gridError}</span>
                      </div>
                    </td>
                  </tr>
                ) : records.length === 0 ? (
                  <tr className="state-empty">
                    <td colSpan={8}>
                      <div className="empty-container">
                        <svg className="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <circle cx="12" cy="12" r="10"></circle>
                          <line x1="12" y1="8" x2="12" y2="12"></line>
                          <line x1="12" y1="16" x2="12.01" y2="16"></line>
                        </svg>
                        <span className="empty-title">No Records Found</span>
                        <span class="empty-desc">Upload an Excel or adjust filters to populate contacts.</span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  records.map((rec) => {
                    const delStatusLower = (rec.delivery_status || 'unsent').toLowerCase();
                    let delBadge = 'badge-unsent';
                    if (delStatusLower === 'sent') delBadge = 'badge-sent';
                    if (delStatusLower === 'delivered') delBadge = 'badge-delivered';
                    if (delStatusLower === 'read') delBadge = 'badge-read';
                    if (delStatusLower === 'failed') delBadge = 'badge-failed';

                    const respLower = (rec.parent_response || 'no response').toLowerCase();
                    let respBadge = 'badge-no-response';
                    if (respLower === 'interested') respBadge = 'badge-interested';
                    if (respLower === 'not interested') respBadge = 'badge-not-interested';

                    return (
                      <tr key={rec.id}>
                        <td style={{ textAlign: 'center' }}>
                          <input 
                            type="checkbox" 
                            style={{ 
                              cursor: isRecordEligibleForBulk(rec) ? 'pointer' : 'not-allowed',
                              opacity: isRecordEligibleForBulk(rec) ? 1 : 0.5
                            }}
                            checked={selectedRecordIds.includes(rec.id)}
                            disabled={!isRecordEligibleForBulk(rec)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedRecordIds(prev => [...prev, rec.id]);
                              } else {
                                setSelectedRecordIds(prev => prev.filter(id => id !== rec.id));
                              }
                            }}
                          />
                        </td>
                        <td>
                          <span className="cell-title">{rec.student_name}</span>
                          <span className="cell-subtitle">ID: {rec.id}</span>
                        </td>
                        <td>
                          <span className="cell-title">{rec.parent_name}</span>
                          <span className="cell-subtitle">Parent</span>
                        </td>
                        <td>
                          <span className="cell-title">{rec.selected_branch}</span>
                        </td>
                        <td>
                          <span className="cell-title">+{rec.phone_number}</span>
                        </td>
                        <td>
                          <span className={`badge ${delBadge}`}>
                            <span className="badge-dot"></span>
                            {rec.delivery_status}
                          </span>
                        </td>
                        <td>
                          <span className={`badge ${respBadge}`}>
                        {rec.parent_response}
                          </span>
                        </td>
                        <td className="text-right">
                          <div className="table-actions">
                            <button 
                              onClick={() => handleSendSingle(rec.id)} 
                              className="btn btn-secondary btn-sm"
                              disabled={rec.parent_response === 'Interested'}
                              title={rec.parent_response === 'Interested' ? "Parent has confirmed interest" : ""}
                            >
                              {rec.campaign_status === 'Pending' ? 'Send' : 'Resend'}
                            </button>
                            <button onClick={() => selectSimTarget(rec)} className="btn btn-secondary btn-sm">
                              Simulate
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Table Pagination Footer */}
          <div className="grid-footer">
            <span className="footer-text">
              Showing {records.length === 0 ? 0 : (currentPage - 1) * RECORDS_PER_PAGE + 1} to{' '}
              {Math.min(currentPage * RECORDS_PER_PAGE, totalCount)} of {totalCount} records
            </span>
            <div className="pagination-controls">
              <button 
                onClick={() => changePage(-1)} 
                className="btn btn-secondary btn-sm" 
                disabled={currentPage <= 1}
              >
                Previous
              </button>
              <span className="page-indicator">Page {currentPage} of {totalPages || 1}</span>
              <button 
                onClick={() => changePage(1)} 
                className="btn btn-secondary btn-sm" 
                disabled={currentPage >= totalPages}
              >
                Next
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* 3. Slide-Out Developer Webhook Sandbox Drawer */}
      <div 
        className={`sandbox-backdrop ${drawerOpen ? '' : 'hidden'}`} 
        onClick={() => setDrawerOpen(false)}
      />
      <aside className={`sandbox-drawer ${drawerOpen ? 'open' : ''}`}>
        <div className="drawer-header">
          <h3>Dev Sandbox Simulator</h3>
          <button onClick={() => setDrawerOpen(false)} className="btn-close-drawer">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div className="drawer-content">
          <p className="drawer-desc">
            Simulate async webhook responses from third-party WhatsApp gateways (sent ➔ delivered ➔ read) or parent action clicks (Interested / Not Interested).
          </p>

          <div className="simulator-card selection-card">
            <h5>1. Target Record Selection</h5>
            {selectedRecord ? (
              <div className="sim-details-active">
                <span className="sim-meta-label">Student:</span>
                <span className="sim-meta-val">{selectedRecord.student_name} (ID: {selectedRecord.id})</span>
                <span className="sim-meta-label">Parent:</span>
                <span className="sim-meta-val">{selectedRecord.parent_name}</span>
                <span className="sim-meta-label">Phone:</span>
                <span className="sim-meta-val">+{selectedRecord.phone_number}</span>
                <span className="sim-meta-label">Message ID:</span>
                <span className="sim-meta-val" style={{ wordBreak: 'break-all', fontFamily: 'monospace' }}>
                  {selectedRecord.message_id ? selectedRecord.message_id : <span className="text-coral">Not Sent (Will auto-generate on click)</span>}
                </span>
              </div>
            ) : (
              <div className="sim-details-empty">
                Select a row record by clicking its simulated trigger button in the main table.
              </div>
            )}
          </div>

          {selectedRecord && (
            <div className="simulator-card preview-card">
              <h5>Simulated Parent Phone View</h5>
              <div className="sandbox-phone-mockup" style={{ 
                background: '#e5ddd5', 
                padding: '16px 12px',
                borderRadius: '8px',
                border: '1px solid #cbd5e1',
                maxHeight: '340px',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                backgroundImage: 'url("https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png")',
                backgroundSize: 'cover'
              }}>
                <div className="whatsapp-bubble" style={{ 
                  background: '#ffffff',
                  padding: '8px 10px',
                  borderRadius: '8px',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
                  position: 'relative',
                  alignSelf: 'flex-start',
                  maxWidth: '90%',
                  fontSize: '0.813rem'
                }}>
                  {/* Render attached template media if configured */}
                  {mediaType === 'image' && mediaUrl && (
                    <div className="bubble-media-preview" style={{ marginBottom: '6px' }}>
                      <img 
                        src={mediaUrl.startsWith('/') ? `${API_BASE}${mediaUrl}` : mediaUrl} 
                        alt="Outreach Media" 
                        style={{ width: '100%', borderRadius: '6px', maxHeight: '160px', objectFit: 'cover' }} 
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    </div>
                  )}
                  {mediaType === 'document' && mediaUrl && (
                    <div className="bubble-media-preview" style={{ 
                      marginBottom: '8px', 
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: '8px', 
                      padding: '8px 10px', 
                      background: '#f0f2f5', 
                      borderRadius: '6px',
                      borderLeft: '4px solid #00a884'
                    }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" style={{ flexShrink: 0 }}>
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                        <polyline points="14 2 14 8 20 8"></polyline>
                      </svg>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.75rem', color: '#475569' }}>
                        <strong>{mediaFilename || 'document.pdf'}</strong>
                      </div>
                    </div>
                  )}
                  
                  {/* Compiled body text */}
                  <div className="bubble-text" style={{ whiteSpace: 'pre-wrap', color: '#1e293b', fontSize: '0.813rem', lineHeight: '1.4' }}>
                    {templateText
                      ? templateText
                          .replace(/\[Parent Name\]/g, selectedRecord.parent_name)
                          .replace(/\[Student Name\]/g, selectedRecord.student_name)
                          .replace(/\[Selected Branch\]/g, selectedRecord.selected_branch)
                          .replace(/\[Phone Number\]/g, selectedRecord.phone_number)
                      : "No active template text."}
                  </div>

                  {/* Bubble timestamps */}
                  <div style={{ textAlign: 'right', fontSize: '0.625rem', color: '#94a3b8', marginTop: '4px' }}>
                    {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>

                {/* Interactive Action Buttons */}
                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <button 
                    onClick={() => triggerWebhookSimulation('Interested')}
                    style={{
                      flex: 1,
                      background: '#ffffff',
                      color: '#00a884',
                      border: '1px solid #cbd5e1',
                      padding: '6px',
                      borderRadius: '20px',
                      fontSize: '0.75rem',
                      fontWeight: '600',
                      cursor: 'pointer',
                      boxShadow: '0 1px 1px rgba(0,0,0,0.05)',
                      textAlign: 'center'
                    }}
                  >
                    Reply: Interested
                  </button>
                  <button 
                    onClick={() => triggerWebhookSimulation('Not Interested')}
                    style={{
                      flex: 1,
                      background: '#ffffff',
                      color: '#ef4444',
                      border: '1px solid #cbd5e1',
                      padding: '6px',
                      borderRadius: '20px',
                      fontSize: '0.75rem',
                      fontWeight: '600',
                      cursor: 'pointer',
                      boxShadow: '0 1px 1px rgba(0,0,0,0.05)',
                      textAlign: 'center'
                    }}
                  >
                    Reply: Not Interested
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="simulator-card actions-card">
            <h5>2. Fire Webhook Callback</h5>
            <div className="simulation-actions-grid">
              <button 
                onClick={() => triggerWebhookSimulation('delivered')} 
                className="btn btn-secondary sim-action-btn"
                disabled={simButtonsDisabled}
              >
                Simulate Delivery (Delivered)
              </button>
              <button 
                onClick={() => triggerWebhookSimulation('read')} 
                className="btn btn-secondary sim-action-btn"
                disabled={simButtonsDisabled}
              >
                Simulate Reading (Seen)
              </button>
              <button 
                onClick={() => triggerWebhookSimulation('failed')} 
                className="btn btn-secondary sim-action-btn text-coral"
                disabled={simButtonsDisabled}
                style={{ borderColor: 'var(--color-coral)' }}
              >
                Simulate Failure (Failed)
              </button>
              <button 
                onClick={() => triggerWebhookSimulation('Interested')} 
                className="btn btn-success sim-action-btn"
                disabled={simButtonsDisabled}
              >
                Simulate Click: Interested
              </button>
              <button 
                onClick={() => triggerWebhookSimulation('Not Interested')} 
                className="btn btn-danger sim-action-btn"
                disabled={simButtonsDisabled}
              >
                Simulate Click: Not Interested
              </button>
            </div>
          </div>

          <div className="simulator-logs">
            <h5>Simulation Event Logs</h5>
            <div className="console-box">
              {consoleLogs.map((log, idx) => (
                <div key={idx} className={`log-line log-${log.level}`}>
                  [{log.time}] {log.text}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      </aside>

      {/* 4. Global notifications toaster container */}
      <div className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type} show`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ color: 'inherit', display: 'flex', alignItems: 'center' }}>
                {toast.type === 'success' && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                )}
                {toast.type === 'error' && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                )}
                {toast.type === 'info' && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                )}
              </span>
              <span className="toast-content">{toast.message}</span>
            </div>
            <button onClick={() => removeToast(toast.id)} className="btn-toast-close">&times;</button>
          </div>
        ))}
      </div>

      {/* 5. Custom Premium Confirmation Modal */}
      {confirmModal.isOpen && (
        <div className="confirm-modal-overlay">
          <div className="confirm-modal-card">
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
              <div className="confirm-modal-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                  <line x1="12" y1="9" x2="12" y2="13"></line>
                  <line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>
              </div>
              <div style={{ flexGrow: 1 }}>
                <h4 style={{
                  margin: 0,
                  fontSize: '1.125rem',
                  fontWeight: '600',
                  color: 'var(--text-primary)',
                  lineHeight: '1.5'
                }}>{confirmModal.title}</h4>
                <p style={{
                  margin: '0.5rem 0 0 0',
                  fontSize: '0.875rem',
                  color: 'var(--text-secondary)',
                  lineHeight: '1.5'
                }}>{confirmModal.message}</p>
              </div>
            </div>
            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '0.75rem',
              marginTop: '0.5rem'
            }}>
              <button
                onClick={closeConfirmModal}
                className="btn btn-secondary"
                style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', height: 'auto' }}
              >
                Cancel
              </button>
              <button
                onClick={confirmModal.onConfirm}
                className="btn btn-primary"
                style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', height: 'auto' }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
